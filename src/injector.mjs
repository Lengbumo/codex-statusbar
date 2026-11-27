// turn-stats-bar 状态栏注入器（CDP 方案）
// 连接 Codex 桌面应用（需以 --remote-debugging-port=9222 启动），
// 在输入框上方注入一条单行中文状态栏，数据按“当前对话”读 rollout 文件，
// 不依赖 MCP widget，避免空白块与串线程。
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_PORT = process.env.TURN_STATS_CDP_PORT || "9224";
const HOST = `127.0.0.1:${CDP_PORT}`;
const POLL_MS = 2500;
const CODE_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const RATE_CARD_PATH = path.join(
  CODE_HOME,
  "codex-usage-tracker",
  "kernel-v1",
  "rate-card.json",
);
const SESSION_ROOTS = [
  path.join(CODE_HOME, "sessions"),
  path.join(CODE_HOME, "archived_sessions"),
];
const DEFAULT_MODEL = process.env.TURN_STATS_MODEL || "deepseek-v4-flash";

// ---------- 页面注入脚本（幂等，随 tick 重发） ----------
const INSTALL_SCRIPT = String.raw`
(function () {
  var VERSION = 18;
  if (window.__catStatuslineInstalled) {
    if (window.__catStatuslineVersion === VERSION) {
      try { window.__catStatuslineEnsure && window.__catStatuslineEnsure(); } catch (e) {}
      return;
    }
    try { if (window.__catStatuslineObserver) window.__catStatuslineObserver.disconnect(); } catch (e) {}
    var old = document.getElementById('cat-statusline');
    if (old) old.remove();
    var oldStyle = document.getElementById('cat-statusline-style');
    if (oldStyle) oldStyle.remove();
  }
  window.__catStatuslineVersion = VERSION;
  window.__catStatuslineInstalled = true;

  function ensureStyle() {
    if (document.getElementById('cat-statusline-style')) return;
    var st = document.createElement('style');
    st.id = 'cat-statusline-style';
    st.textContent =
      '#cat-statusline{position:fixed;left:12px;right:12px;bottom:6px;display:flex;align-items:center;padding:3px 12px 5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;line-height:1.55;color:var(--color-token-text-secondary,#9aa1aa);white-space:nowrap;overflow:hidden;background:var(--color-token-bg-primary,#ffffff);border:1px solid color-mix(in srgb,var(--color-token-border,rgba(128,128,128,.28)) 55%,transparent);border-bottom:none;border-radius:10px 10px 0 0;user-select:none;z-index:2147483000;transition:bottom .12s ease}' + '#cat-statusline.csl-embedded{box-shadow:none}' + '#cat-statusline #cat-statusline-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
      '#cat-statusline .csl-off{opacity:.55}' +
      '#cat-statusline .csl-seg{display:inline-flex;align-items:baseline;gap:3px}' +
      '#cat-statusline .csl-ico{opacity:.7;display:inline-flex;align-items:center}' + '#cat-statusline .csl-ico svg{display:block}' +
      '#cat-statusline .csl-lbl{opacity:.5;font-size:.92em}' +
      '#cat-statusline .csl-val{font-weight:600;color:var(--color-token-text-primary,#e6e8eb)}' +
      '#cat-statusline .csl-dot{opacity:.4;margin:0 7px}' +
      '#cat-statusline .csl-model .csl-val{color:#7fb8ff}' +
      '#cat-statusline .csl-ctx .csl-val{color:#4ade80}' +
      '#cat-statusline .csl-warn .csl-val{color:#f0b429}' +
      '#cat-statusline .csl-danger .csl-val{color:#ff6b6b}' +
      '#cat-statusline .csl-turn .csl-val{color:#b8a8ff}' +
      '#cat-statusline .csl-tools .csl-val{color:#7bd4a8}' + '#cat-statusline .csl-sub{opacity:.55;font-size:.92em;margin-left:3px}' + '#cat-statusline .csl-ctxbar{display:inline-block;width:44px;height:4px;margin-left:4px;background:rgba(128,128,128,.25);border-radius:2px;overflow:hidden;vertical-align:middle}' + '#cat-statusline .csl-ctxbar > span{display:block;height:100%;background:#4ade80;border-radius:2px;transition:width .4s ease}' + '#cat-statusline .csl-warn .csl-ctxbar > span{background:#f0b429}' + '#cat-statusline .csl-danger .csl-ctxbar > span{background:#ff6b6b}' + '#cat-statusline .csl-fail{color:#ff6b6b;font-weight:700;margin-left:4px;font-size:.92em}' +
      '#cat-statusline .csl-gear{cursor:pointer;opacity:.5;margin-left:8px}' +
      '#cat-statusline .csl-gear:hover{opacity:1}' +
      '#cat-statusline-settings{position:fixed;right:16px;bottom:110px;z-index:2147483001;background:var(--color-token-bg-primary,#ffffff);border:1px solid color-mix(in srgb,var(--color-token-border,rgba(128,128,128,.4)) 70%,transparent);border-radius:10px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:170px}' +
      '#cat-statusline-settings .csl-panel-title{font-weight:600;margin-bottom:4px;color:var(--color-token-text-primary,#1d1f24)}' +
      '#cat-statusline-settings label{display:flex;align-items:center;gap:6px;color:var(--color-token-text-secondary,#3d4350);cursor:pointer}' +
      '#cat-statusline-settings input[type=number]{width:52px;background:transparent;border:1px solid rgba(128,128,128,.4);border-radius:6px;color:var(--color-token-text-primary,#1d1f24);padding:2px 4px}' +
      '#cat-statusline-settings button{margin-top:6px;background:#2c6ecb;border:none;border-radius:6px;color:#fff;padding:4px 0;cursor:pointer;font-size:12px}';
    (document.head || document.documentElement).appendChild(st);
  }

  // 输入框可见容器：contenteditable 优先（切对话后 .ProseMirror 可能是 0x0 隐藏旧节点），
  // 再向上找明显圆角的祖先。rect 无效的候选一律排除，找不到返回 null（贴窗口底，绝不飞出视口）。
  function composerBox() {
    var candidates = document.querySelectorAll('[contenteditable="true"], .ProseMirror');
    var editor = null;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var r = el.getBoundingClientRect();
      if (r.width > 200 && r.height >= 20 && r.top >= 0 && r.bottom <= window.innerHeight + 60) { editor = el; break; }
    }
    if (!editor) return null;
    var walk = editor;
    for (var j = 0; walk && j < 8; j++, walk = walk.parentElement) {
      try {
        var cs = getComputedStyle(walk);
        var r2 = walk.getBoundingClientRect();
        if (parseFloat(cs.borderRadius) >= 10 && r2.width > 300 && r2.height > 40 && r2.top >= 0) return walk;
      } catch (e) {}
    }
    return editor;
  }

  function composerHost() {
    var pm = document.querySelector('.ProseMirror');
    if (pm) {
      var f = pm.closest('form');
      if (f) return f;
      var p = pm.parentElement;
      for (var i = 0; p && i < 6; i++, p = p.parentElement) {
        if (p.querySelector && p.querySelector('button[class*="size-token-button-compose"]')) return p;
      }
    }
    var send = document.querySelector('button[class*="size-token-button-compose"]');
    if (send) {
      var c = send.closest('form') || send.parentElement;
      return c;
    }
    return null;
  }

  function ensure() {
    var node = document.getElementById('cat-statusline');
    if (!node) {
      node = document.createElement('div');
      node.id = 'cat-statusline';
      var txt = document.createElement('span');
      txt.id = 'cat-statusline-text';
      txt.textContent = '— · — · 缓存 —% · 上下文 —/— · —→— · 本轮 — · 线程 —';
      node.appendChild(txt);
    }
    // 永远 body 直属 + fixed 定位：绝不进入 React 管理的子树，
    // 切换对话 / 页面重渲染都不会移除或隐藏状态栏（zcode overlay 同款策略）
    if (node.parentNode !== document.body) document.body.appendChild(node);
    node.style.display = '';
    // 对话切换即时通知：页面侧一检测到 convId 变化就发标记，注入器立刻刷新
    var cur = resolveConvId();
    if (cur !== window.__catStatuslineLastConv) {
      window.__catStatuslineLastConv = cur;
      try { console.log('__catStatuslineRefresh'); } catch (e) {}
    }
    // 位置：与输入框容器左右对齐、紧贴其上边缘，视觉上嵌入输入框顶部；
    // 输入框不可见/rect 无效（切对话瞬间、任务运行中）→ 横跨窗口底部，保证始终可见
    var host = composerBox();
    var r = host ? host.getBoundingClientRect() : null;
    if (r && r.width > 300 && r.height > 40 && r.top >= 0 && window.innerHeight - r.top >= 60) {
      node.style.left = Math.max(8, r.left) + 'px';
      node.style.right = 'auto';
      node.style.width = r.width + 'px';
      node.style.maxWidth = 'none';
      node.style.bottom = Math.max(0, window.innerHeight - r.top) + 'px';
      node.classList.add('csl-embedded');
    } else {
      node.style.left = '12px';
      node.style.right = '12px';
      node.style.width = 'auto';
      node.style.maxWidth = 'none';
      node.style.bottom = '6px';
      node.classList.remove('csl-embedded');
    }
  }

  window.__catStatuslineEnsure = ensure;
  if (!window.__catStatuslinePosTimer) {
    window.__catStatuslinePosTimer = setInterval(function () { try { ensure(); } catch (e) {} }, 1500);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cslConf() {
    var d = { show: { tps: 1, turn: 1, session: 1, ctx: 1, tools: 1, today: 1 }, fontSize: 12, fmt: 'cn' };
    try {
      var c = JSON.parse(localStorage.getItem('cat-statusline-config') || '{}');
      if (c.show) for (var k in d.show) if (k in c.show) d.show[k] = !!c.show[k];
      if (c.fontSize) d.fontSize = Math.min(18, Math.max(9, parseInt(c.fontSize, 10) || 12));
      if (c.fmt) d.fmt = c.fmt === "cn" ? "cn" : "k";
    } catch (e) {}
    return d;
  }

  var CSL_ITEMS = [
    ['tps', '生成速度'], ['turn', '本轮'], ['session', '会话累计'], ['ctx', '上下文'],
    ['tools', '工具调用'], ['today', '今日合计'],
  ];

  function toggleSettings() {
    var old = document.getElementById('cat-statusline-settings');
    if (old) { old.remove(); return; }
    var conf = cslConf();
    var html = '<div class="csl-panel-title">状态栏显示设置</div>';
    for (var i = 0; i < CSL_ITEMS.length; i++) {
      var it = CSL_ITEMS[i];
      html += '<label><input type="checkbox" data-k="' + it[0] + '"' + (conf.show[it[0]] ? ' checked' : '') + '/>' + it[1] + '</label>';
    }
    html += '<label>字号<input type="number" min="9" max="18" value="' + conf.fontSize + '" data-fs="1"/></label>';
    html += '<label>数字格式<select data-fmt="1"><option value="k"' + (conf.fmt !== "cn" ? " selected" : "") + '>k / M</option><option value="cn"' + (conf.fmt === "cn" ? " selected" : "") + '>万 / 亿</option></select></label>';
    html += '<button type="button" data-done="1">完成</button>';
    var panel = document.createElement('div');
    panel.id = 'cat-statusline-settings';
    panel.innerHTML = html;
    document.body.appendChild(panel);
    panel.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var c = cslConf();
      if (t.getAttribute('data-fs') !== null) {
        c.fontSize = Math.min(18, Math.max(9, parseInt(t.value, 10) || 12));
      } else if (t.getAttribute('data-fmt') !== null) {
        c.fmt = t.value === "cn" ? "cn" : "k";
      } else if (t.getAttribute('data-k')) {
        c.show[t.getAttribute('data-k')] = t.checked;
      } else { return; }
      localStorage.setItem('cat-statusline-config', JSON.stringify(c));
      try { window.__catStatuslineUpdate(window.__catStatuslineParts || [], window.__catStatuslineLastConvId); } catch (err) {}
    });
    panel.addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-done')) panel.remove();
    });
  }

  window.__catStatuslineUpdate = function (parts, convId) {
    var node = document.getElementById('cat-statusline');
    if (!node) return;
    if (convId != null && resolveConvId() !== convId) return;
    window.__catStatuslineParts = parts;
    window.__catStatuslineLastConvId = convId;
    var txt = document.getElementById('cat-statusline-text');
    if (!txt) return;
    var conf = cslConf();
    node.style.fontSize = conf.fontSize + 'px';
    var arr = Array.isArray(parts) ? parts : [];
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (!p || (p.key !== 'wait' && !conf.show[p.key])) continue;
      html += '<span class="csl-seg ' + (p.cls || '') + '"' + (p.detail ? ' title="' + escapeHtml(p.detail) + '"' : '') + '>'
        + (p.icon ? '<span class="csl-ico">' + (p.icon.indexOf('<svg') === 0 ? p.icon : escapeHtml(p.icon)) + '</span>' : '')
        + (p.label ? '<span class="csl-lbl">' + escapeHtml(p.label) + '</span>' : '')
        + '<span class="csl-val">' + escapeHtml(p.text) + '</span>'
        + (p.sub ? '<span class="csl-sub">' + escapeHtml(p.sub) + '</span>' : '')
        + (p.fail ? '<span class="csl-fail">🔴' + escapeHtml(p.fail) + '</span>' : '')
        + (p.bar !== undefined && p.bar !== null ? '<span class="csl-ctxbar"><span style="width:' + p.bar + '%"></span></span>' : '')
        + '</span>'
        + '<span class="csl-dot">·</span>';
    }
    html += '<span class="csl-gear" title="显示设置">⚙</span>';
    txt.innerHTML = html;
    var gear = txt.querySelector('.csl-gear');
    if (gear) gear.onclick = toggleSettings;
  };
  window.__catStatuslineSetOffline = function (off) {
    var node = document.getElementById('cat-statusline');
    if (node) node.classList.toggle('csl-off', !!off);
  };

  ensureStyle();
  ensure();
  // 只创建一次 observer；用 rAF 合并高频 DOM 变化，避免切换对话时反复重挂状态栏
  if (!window.__catStatuslineObserver || window.__catStatuslineObserverVersion !== VERSION) {
    if (window.__catStatuslineObserver) {
      try { window.__catStatuslineObserver.disconnect(); } catch (e) {}
    }
    var ensurePending = false;
    function scheduleEnsure() {
      if (ensurePending) return;
      ensurePending = true;
      (window.requestAnimationFrame || function (cb) { setTimeout(cb, 50); })(function () {
        ensurePending = false;
        try { ensure(); } catch (e) {}
      });
    }
    window.__catStatuslineObserver = new MutationObserver(scheduleEnsure);
    window.__catStatuslineObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.__catStatuslineObserverVersion = VERSION;
  }

  // ---------- 读取当前对话（React fiber，来自 codex-app-transfer 验证过的方案） ----------
  var __CONVID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function fiberOf(el) {
    if (!el) return null;
    for (var k in el) { if (k.indexOf('__reactFiber$') === 0) return el[k]; }
    return null;
  }
  function convIdFromFiber(start) {
    if (!start) return null;
    var f = fiberOf(start), n = 0;
    while (f && n < 40) {
      var bags = [f.memoizedProps, f.memoizedState];
      for (var b = 0; b < bags.length; b++) {
        var bag = bags[b];
        if (bag && typeof bag === 'object') {
          for (var key in bag) {
            if (key === 'conversationId' || /[Cc]onversationId$/.test(key)) {
              var v = bag[key];
              if (typeof v === 'string' && __CONVID_RE.test(v)) return v;
            }
          }
        }
      }
      f = f.return; n++;
    }
    return null;
  }
  function sidebarConvId() {
    try {
      var active = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
      if (active) {
        var raw = active.getAttribute('data-app-action-sidebar-thread-id') || '';
        var id = raw.replace(/^local:/, '');
        if (__CONVID_RE.test(id)) return id;
      }
    } catch (e) {}
    return null;
  }
  function fiberConvId() {
    try {
      var pm = document.querySelector('.ProseMirror');
      var start = pm;
      for (var depth = 0; start && depth < 20; depth++, start = start.parentElement) {
        var f = fiberOf(start);
        if (!f) continue;
        var id = null;
        var n = 0;
        while (f && n < 120) {
          var bags = [f.memoizedProps, f.memoizedState];
          for (var b = 0; b < bags.length; b++) {
            var bag = bags[b];
            if (bag && typeof bag === 'object') {
              for (var key in bag) {
                if (key === 'conversationId' || /[Cc]onversationId$/.test(key)) {
                  var v = bag[key];
                  if (typeof v === 'string' && __CONVID_RE.test(v)) id = v;
                }
              }
            }
          }
          if (id) break;
          f = f.return; n++;
        }
        if (id) return id;
      }
    } catch (e) {}
    return null;
  }
  // 双来源校验：都存在且一致才用；若仅有一个来源（新对话尚未生成侧边栏条目等），
  // 用唯一来源；两个来源都存在但不一致 → null（fail-closed，绝不串对话）
  function resolveConvId() {
    // 侧边栏 selected 属性与界面渲染同源，是"当前显示对话"的权威信号；
    // fiber 读输入框组件状态，切换对话后可能残留旧值（实测），仅在 sidebar 缺失时兜底。
    var a = sidebarConvId();
    if (a) return a;
    return fiberConvId() || null;
  }
  function readCtxUsage() {
    try {
      var ring = document.querySelector('[aria-label^="Context usage:"]');
      if (!ring) return null;
      var f = fiberOf(ring), n = 0;
      while (f && n < 25) {
        var bags = [f.memoizedProps, f.memoizedState];
        for (var b = 0; b < bags.length; b++) {
          var bag = bags[b];
          if (bag && typeof bag === 'object') {
            for (var key in bag) {
              var v = bag[key];
              if (v && typeof v === 'object' &&
                  typeof v.usedTokens === 'number' && typeof v.contextWindow === 'number') {
                return { used: v.usedTokens, win: v.contextWindow };
              }
            }
          }
        }
        f = f.return; n++;
      }
    } catch (e) {}
    return null;
  }

  // ---------- 实时 tps：监听对话流文本增量（2s 滑窗，字符→token 粗估） ----------
  if (!window.__catStatuslineTpsObs) {
    var lastText = '';
    var lastAt = 0;
    var lastTps = null;
    function sample() {
      var scroller = document.querySelector('[data-testid^="conversation"], [class*="thread"]');
      var text = scroller ? (scroller.innerText || '') : '';
      var now = Date.now();
      if (lastAt) {
        var dt = (now - lastAt) / 1000;
        var d = Math.max(0, text.length - lastText.length);
        if (dt > 0.5 && dt < 10 && d > 0) {
          lastTps = Math.round((d / dt) * 0.6); // 中文≈0.6 token/字
        }
      }
      lastText = text;
      lastAt = now;
      window.__lastStatuslineTps = lastTps;
    }
    window.__catStatuslineTpsObs = new MutationObserver(function () {
      var now = Date.now();
      if (now - (window.__catStatuslineLastSampleAt || 0) >= 2000) {
        window.__catStatuslineLastSampleAt = now;
        sample();
      }
    });
    var root = document.body || document.documentElement;
    window.__catStatuslineTpsObs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  window.__catStatuslineRead = function () {
    var a = sidebarConvId();
    var b = fiberConvId();
    return {
      convId: resolveConvId(),
      sidebarId: a,
      fiberId: b,
      confident: !!(a && b && a === b),
      ctx: readCtxUsage(),
      lastTps: window.__lastStatuslineTps || null,
    };
  };
})();
`;

// ---------- rollout 解析 ----------
function walkFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

// rollout 索引：30 秒重建一次，避免每次切换对话都全盘扫目录
let rolloutIndex = new Map();
let rolloutIndexAt = 0;
const ROLLOUT_ID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function refreshRolloutIndex(force) {
  const now = Date.now();
  if (!force && rolloutIndex.size > 0 && now - rolloutIndexAt < 30000) return;
  const index = new Map();
  const files = [];
  for (const root of SESSION_ROOTS) walkFiles(root, files);
  for (const f of files) {
    const m = ROLLOUT_ID_RE.exec(f);
    if (!m) continue;
    const id = m[1];
    const existing = index.get(id);
    if (!existing) {
      index.set(id, f);
      continue;
    }
    try {
      if (statSync(f).mtimeMs > statSync(existing).mtimeMs) index.set(id, f);
    } catch {}
  }
  rolloutIndex = index;
  rolloutIndexAt = now;
}

function findRollout(convId) {
  refreshRolloutIndex(false);
  return rolloutIndex.get(convId) || null;
}

// rollout 缓存：按 convId 缓存路径与解析结果，文件 mtime 未变则不再重读
const rolloutCache = new Map();
function loadRollout(convId) {
  const cached = rolloutCache.get(convId);
  if (cached) {
    try {
      if (statSync(cached.path).mtimeMs === cached.mtimeMs) return cached;
    } catch {
      // file gone: fall through and re-resolve
    }
  }
  let path = findRollout(convId);
  if (!path) {
    // 可能是刚创建的新对话 rollout：强制重建一次索引
    refreshRolloutIndex(true);
    path = rolloutIndex.get(convId) || null;
  }
  if (!path) {
    rolloutCache.delete(convId);
    return null;
  }
  const parsed = parseRollout(path);
  // 空结果（还没有 token 统计）不缓存：文件刚创建瞬间可能读到空，
  // 缓存会导致之后一直显示“等待首次统计”；不缓存则每轮重读直到有数据。
  if (!parsed.last && !parsed.total) {
    rolloutCache.delete(convId);
    return { path, parsed };
  }
  const entry = { path, mtimeMs: statSync(path).mtimeMs, parsed };
  rolloutCache.set(convId, entry);
  return entry;
}

function readRateCard() {
  try {
    const raw = readFileSync(RATE_CARD_PATH, "utf8");
    const card = JSON.parse(raw);
    return card.models || {};
  } catch {
    return {};
  }
}

// 指标图标：统一 SVG 绘制（字符 emoji 在不同字体下渲染不一致，此坑在悬浮窗版已踩过）。
// viewBox 0 0 24 24，样式表固定 17px，stroke 用 currentColor 自动适配明暗主题。
const CSL_ICONS = {
  bolt: '<path d="M13 2 4.5 13.5h6L11 22l8.5-11.5h-6L13 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  bubble: '<path d="M4 5.5h16v11H9l-5 4v-15z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  chat: '<path d="M20 5H8L4 9v10h5l2-2h9V5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 9.5h8M8 12.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  gauge: '<path d="M5 19a8.5 8.5 0 1 1 14 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 13.5 15.5 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  wrench: '<path d="M14.5 6.5a4.5 4.5 0 0 1 5.7-4.3l-3.2 3.2 2.6 2.6L22.8 4.8a4.5 4.5 0 0 1-5.9 5.6L6.5 20.8a2 2 0 0 1-2.8-2.8L14.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  calendar: '',
};
function cslIcon(name) {
  if (name === "calendar") {
    // 完全照抄悬浮窗版：白底灰描边 + 红色顶条 + 深色日期数字，13px
    var day = new Date().getDate();
    return '<svg viewBox="0 0 24 24" width="13" height="13" style="vertical-align:-1px">'
      + '<rect x="1" y="1" width="22" height="22" rx="4" fill="#f6f7f9" stroke="#c9ccd1" stroke-width="1.5"/>'
      + '<rect x="1" y="1" width="22" height="8" rx="4" fill="#ff5c5c"/>'
      + '<rect x="1" y="5" width="22" height="4" fill="#ff5c5c"/>'
      + '<text x="12" y="19" text-anchor="middle" font-size="11" font-weight="600" fill="#2a2c33" font-family="-apple-system,BlinkMacSystemFont,sans-serif">' + day + '</text>'
      + '</svg>';
  }
  return '<svg viewBox="0 0 24 24" width="17" height="17">' + (CSL_ICONS[name] || "") + '</svg>';
}


function fmtK(n, mode) {
  n = Number(n) || 0;
  if (mode === "cn") {
    if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, "") + "亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
    return String(Math.round(n));
  }
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e5) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

const TAIL_BYTES = 512 * 1024;

function parseRollout(file) {
  const st = statSync(file);
  let head = "";
  let body;
  if (st.size <= TAIL_BYTES) {
    body = readFileSync(file, "utf8");
  } else {
    // 大文件只读头部（会话 id）+ 尾部（最新 token 统计），避免全量解析卡顿
    const fd = openSync(file, "r");
    try {
      const headBuf = Buffer.alloc(4096);
      readSync(fd, headBuf, 0, 4096, 0);
      head = headBuf.toString("utf8");
      const tailBuf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, tailBuf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
      body = tailBuf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
  const lines = body.split(/\r?\n/);
  let total = null;
  let last = null;
  let contextWindow = null;
  let sessionId = null;
  if (head) {
    const m = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(head);
    if (m) sessionId = m[1];
  }
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session_meta") {
      if (!sessionId && obj.payload?.id) sessionId = obj.payload.id;
      continue;
    }
    if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") continue;
    const info = obj.payload.info || {};
    if (info.model_context_window) contextWindow = info.model_context_window;
    if (info.total_token_usage) total = info.total_token_usage;
    if (info.last_token_usage) last = info.last_token_usage;
  }
  return { total, last, contextWindow, sessionId };
}

// 全量正则扫描：实际模型名（turn_context 最新值）与工具调用次数；大文件仅正则不做逐行 JSON 解析
const extrasCache = new Map();
// 逐事件统计（悬浮窗版 codex-token-statusbar 算法）
function scanExtras(convId) {
  const entry = loadRollout(convId);
  if (!entry?.path) return null;
  let st;
  try { st = statSync(entry.path); } catch { return null; }
  const cached = extrasCache.get(convId);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
  const d = {
    model: null, toolCalls: 0, toolFails: 0, turns: 0, requests: 0, turnReqs: 0,
    sessionTotal: 0, sessionOutput: 0, turnStartTotal: 0, turnStartOutput: 0,
    turnGenMs: 0, lastCountTs: null, lastOutput: null, lastRate: null,
  };
  try {
    const lines = readFileSync(entry.path, "utf8").split("\n");
    let lastTurnLine = -1;
    let lastTurnId = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.includes('"task_started"')) {
        d.turns++;
        lastTurnLine = i;
        try {
          const p = JSON.parse(line).payload || {};
          if (p.turn_id && p.turn_id !== lastTurnId) {
            lastTurnId = p.turn_id;
            d.turnStartTotal = d.sessionTotal;
            d.turnStartOutput = d.sessionOutput;
            d.turnGenMs = 0;
          }
        } catch { /* 行解析失败按计数处理 */ }
      } else if (line.includes('"token_count"')) {
        d.requests++;
        try {
          const info = (JSON.parse(line).payload || {}).info || {};
          const total = info.total_token_usage || {};
          const last = info.last_token_usage || {};
          if (typeof total.total_tokens === "number") d.sessionTotal = total.total_tokens;
          if (typeof total.output_tokens === "number") d.sessionOutput = total.output_tokens;
          const nowTs = Date.parse(obj_ts(line));
          if (Number.isFinite(nowTs)) {
            if (d.lastCountTs !== null && d.lastOutput !== null) {
              const delta = nowTs - d.lastCountTs;
              if (delta >= 200 && delta <= 60000 && d.lastOutput > 0) {
                d.lastRate = Math.round(d.lastOutput / delta * 1000 * 10) / 10;
              }
            }
            d.lastCountTs = nowTs;
            d.lastOutput = last.output_tokens || 0;
          }
        } catch { /* 跳过坏行 */ }
      } else if (line.includes('"item_completed"')) {
        try {
          const p = JSON.parse(line).payload || {};
          const it = (p.item || {}).type;
          const s = p.started_at_ms;
          const c = p.completed_at_ms;
          if ((it === "Reasoning" || it === "AgentMessage") && typeof s === "number" && typeof c === "number" && c > s) {
            d.turnGenMs += c - s;
          }
        } catch { /* 跳过坏行 */ }
      } else if (line.includes('"function_call"')) {
        d.toolCalls++;
        if (line.includes('"status":"failed"')) d.toolFails++;
      }
      if (!d.model && line.includes('"model"')) {
        const mm = /"model"\s*:\s*"([^"]+)"/.exec(line);
        if (mm) d.model = mm[1];
      }
    }
    for (let i = lastTurnLine + 1; i < lines.length; i++) {
      if (lines[i] && lines[i].includes('"token_count"')) d.turnReqs++;
    }
  } catch { /* 读取失败保持空数据 */ }
  const turnOutput = Math.max(0, d.sessionOutput - d.turnStartOutput);
  d.turnRate = d.turnGenMs > 0 && turnOutput > 0 ? Math.round(turnOutput / d.turnGenMs * 1000 * 10) / 10 : null;
  d.turnTokens = Math.max(0, d.sessionTotal - d.turnStartTotal);
  extrasCache.set(convId, { mtimeMs: st.mtimeMs, data: d });
  return d;
}

function obj_ts(line) {
  const m = /"timestamp":"([^"]+)"/.exec(line);
  return m ? m[1] : "";
}

// 今日新增：当日 0 点后逐条 token_count 的 last.total_tokens 累加（悬浮窗版口径）
const todayCache = { files: new Map(), data: null, scanAt: 0 };
function todaySummary() {
  if (todayCache.data && Date.now() - todayCache.scanAt < 60000) return todayCache.data;
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dir = path.join(
    SESSION_ROOTS[0],
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return todayCache.data; }
  let tokens = 0, turns = 0, requests = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.mtimeMs < dayStart) continue;
    const cached = todayCache.files.get(f);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      tokens += cached.tokens; turns += cached.turns; requests += cached.requests;
      continue;
    }
    const fd = { tokens: 0, turns: 0, requests: 0 };
    try {
      const lines = readFileSync(full, "utf8").split("\n");
      for (const line of lines) {
        if (!line) continue;
        if (line.includes('"task_started"')) fd.turns++;
        if (line.includes('"token_count"')) {
          fd.requests++;
          const ts = Date.parse(obj_ts(line));
          if (!Number.isFinite(ts) || ts < dayStart) continue;
          const mm = /"last_token_usage":\{[^}]*"total_tokens":(\d+)/.exec(line);
          if (mm) fd.tokens += Number(mm[1]);
        }
      }
    } catch { /* 跳过坏文件 */ }
    todayCache.files.set(f, { mtimeMs: st.mtimeMs, ...fd });
    tokens += fd.tokens; turns += fd.turns; requests += fd.requests;
  }
  todayCache.data = { tokens, turns, requests };
  todayCache.scanAt = Date.now();
  return todayCache.data;
}

function buildLine(convId, ctx, tps, rates, fmt) {
  const entry = convId ? loadRollout(convId) : null;
  const rollout = entry?.path ?? null;
  let parsed = entry?.parsed ?? { total: null, last: null, contextWindow: null, sessionId: null };
  // 严格身份校验：文件内 session_meta.id 必须等于当前对话，否则按无数据处理
  if (parsed.sessionId && parsed.sessionId !== convId) {
    parsed = { total: null, last: null, contextWindow: null, sessionId: null };
  }
  const stats = convId ? scanExtras(convId) : null;
  const last = parsed.last || {};
  const total = parsed.total || {};
  // 上下文兜底：最新请求输入量 ≈ 当前上下文已用，窗口取 token_count 的 model_context_window
  const ctxUsed = ctx?.used ?? (Number(last.input_tokens) > 0 ? Number(last.input_tokens) : null);
  const ctxWin = ctx?.win ?? (Number(parsed.contextWindow) > 0 ? Number(parsed.contextWindow) : null);
  const effCtx = ctxUsed !== null && ctxWin !== null ? { used: ctxUsed, win: ctxWin } : ctx;
  const hasLast = (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0) > 0;

  const hasData = !!(convId && rollout && last.input_tokens);
  if (!hasData) {
    const wait = convId ? (rollout ? "等待首次统计…" : "等待首个请求…") : null;
    return { parts: wait ? [{ key: "wait", text: wait }] : [], hasData };
  }

  const cachedIn = Number(last.cached_input_tokens) || 0;
  const reasoning = Number(last.reasoning_output_tokens) || 0;
  const turnTok = stats?.turnTokens ?? 0;
  const totalTok = Number(total.total_tokens || 0);
  const today = todaySummary();
  const parts = [
    {
      key: "tps", cls: "csl-tps",
      icon: "⚡",
      text: stats?.turnRate !== null && stats?.turnRate !== undefined ? `≈${stats.turnRate} tps` : "—", sub: "",
      detail: "本轮生成速度 = 本轮新增 output ÷ 纯生成时长（Reasoning/AgentMessage 段累加，工具等待不计）",
    },
    {
      key: "turn", cls: "csl-turn",
      icon: "💬",
      text: fmtK(turnTok, fmt), sub: `${stats?.turnReqs ?? 0}次`,
      detail: `本轮：输入 ${fmtK(last.input_tokens || 0, fmt)}（缓存 ${fmtK(cachedIn, fmt)}）→ 输出 ${fmtK(last.output_tokens || 0, fmt)}（含推理 ${fmtK(reasoning, fmt)}）`,
    },
    {
      key: "session", cls: "csl-session",
      icon: "🗨",
      text: fmtK(totalTok, fmt), sub: `${stats?.turns ?? 0}轮 ${stats?.requests ?? 0}次`,
      detail: "当前对话累计 token / 对话轮数 / 请求次数",
    },
  ];
  if (effCtx && effCtx.win) {
    const used = Number(effCtx.used) || 0;
    const win = Number(effCtx.win) || 0;
    const pct = win > 0 ? (100 * used) / win : null;
    // 悬浮窗版分档：60% 黄、85% 红
    const cls = pct !== null && pct >= 85 ? "csl-danger" : pct !== null && pct >= 60 ? "csl-warn" : "csl-ctx";
    parts.push({
      key: "ctx", cls,
      icon: "▓",
      label: "上下文",
      text: pct === null ? "—" : pct.toFixed(1) + "%",
      sub: "",
      bar: pct === null ? 0 : Math.min(100, pct),
      detail: `窗口 ${fmtK(win, fmt)} · 已用 ${fmtK(used, fmt)}（${pct === null ? "—" : pct.toFixed(1) + "%"}）`,
    });
  }
  parts.push({
    key: "tools", cls: "csl-tools",
    icon: "🔧",
    text: String(stats?.toolCalls ?? 0), sub: "",
    fail: stats?.toolFails ?? 0,
    detail: `本会话工具调用 ${stats?.toolCalls ?? 0} 次${stats?.toolFails ? `，失败 ${stats.toolFails} 次` : ""}`,
  });
  parts.push({
    key: "today", cls: "csl-today",
    icon: cslIcon("calendar"),
    text: fmtK(today?.tokens ?? 0, fmt), sub: `${today?.turns ?? 0}轮 ${today?.requests ?? 0}次`,
    detail: "今日所有会话合计 token / 轮数 / 请求次数",
  });
  return { parts, hasData };
}

// ---------- CDP 客户端（多页面会话） ----------
let refreshRequested = false;

class CdpSession {
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.state = makeConvState();
  }
  async connect() {
    this.ws = await openWs(this.target.webSocketDebuggerUrl, this);
    await this.send("Runtime.enable", {}).catch(() => {});
  }
  send(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("未连接");
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 10000);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error");
    }
    return r.result?.value;
  }
  close() {
    try { if (this.ws) this.ws.close(); } catch {}
  }
}

function openWs(url, session) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let opened = false;
    // onclose 兜底：页面刷新/拒绝连接时可能既不触发 open 也不触发 error，
    // Promise 永久 pending 会让主循环卡死（实测），5s 超时 + close 双保险
    const timer = setTimeout(() => {
      if (!opened) { try { sock.close(); } catch {} reject(new Error("CDP 连接超时")); }
    }, 5000);
    sock.onopen = () => { opened = true; clearTimeout(timer); resolve(sock); };
    sock.onerror = () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); };
    sock.onclose = () => { clearTimeout(timer); if (!opened) reject(new Error("CDP 连接被关闭")); };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.method === "Runtime.consoleAPICalled") {
        try {
          if ((m.params?.args || []).some((a) => a?.value === "__catStatuslineRefresh")) {
            refreshRequested = true;
          }
        } catch {}
        return;
      }
      if (m.id !== undefined && session.pending.has(m.id)) {
        const p = session.pending.get(m.id);
        session.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || "CDP error"));
        else p.resolve(m.result);
      }
    };
  });
}

async function listMainTargets() {
  const res = await fetch(`http://${HOST}/json`);
  const list = await res.json();
  // Codex 新版所有页面 URL 都带 initialRoute 参数，不能再排除；
  // 只排除明确的辅助页面（头像悬浮层等）
  return (list || []).filter(
    (t) => t.type === "page" && (t.webSocketDebuggerUrl || "").length > 0 && !/avatar-overlay/.test(t.url || ""),
  );
}

// ---------- 主循环（每个页面一个独立会话，支持多窗口） ----------
const sessions = new Map();

function makeConvState() {
  return { activeConvId: null, pendingConvId: null, pendingCount: 0, lastTps: null };
}

// 任意有效对话 id 立即切换（页面侧有写入守卫兜底，防串号）。切换瞬间清空 tps。
function resolveConv(state, candidate) {
  if (candidate === state.activeConvId) {
    state.pendingConvId = null;
    state.pendingCount = 0;
    return state.activeConvId;
  }
  if (candidate !== null) {
    state.activeConvId = candidate;
    state.pendingConvId = null;
    state.pendingCount = 0;
    state.lastTps = null;
    return state.activeConvId;
  }
  state.pendingConvId = null;
  state.pendingCount = 0;
  return null;
}

async function syncSessions() {
  const targets = await listMainTargets();
  const ids = new Set(targets.map((t) => t.id));
  for (const [id, sess] of sessions) {
    if (!ids.has(id)) {
      sess.close();
      sessions.delete(id);
      console.log("[turn-stats-bar] 关闭页面", id.slice(0, 8));
    }
  }
  for (const t of targets) {
    if (sessions.has(t.id)) continue;
    const sess = new CdpSession(t);
    try {
      await sess.connect();
      sessions.set(t.id, sess);
      console.log("[turn-stats-bar] 连接页面", t.id.slice(0, 8), t.url.slice(0, 60));
    } catch (e) {
      console.log("[turn-stats-bar] 连接失败", t.id.slice(0, 8), e.message);
    }
  }
}

async function tickSession(sess) {
  const read = await sess.evaluate(
    `${INSTALL_SCRIPT}; window.__catStatuslineRead ? window.__catStatuslineRead() : null;`,
  );
  if (read?.lastTps) sess.state.lastTps = read.lastTps;
  const convId = resolveConv(sess.state, read?.convId ?? null);
  const ctx = read?.ctx || null;
  const rates = readRateCard();
  // 渲染侧配置（localStorage）同步到数据侧：目前用到数字格式 k/万
  let fmt = "k";
  try {
    const rawConf = await sess.evaluate(
      "(function(){ try { return JSON.parse(localStorage.getItem('cat-statusline-config')||'{}').fmt || 'k'; } catch(e){ return 'k'; } })()",
    );
    if (rawConf === "cn") fmt = "cn";
  } catch { /* 保持默认 */ }
  const { parts, hasData } = buildLine(convId, ctx, sess.state.lastTps, rates, fmt);
  await sess.evaluate(
    `window.__catStatuslineUpdate(${JSON.stringify(parts)}, ${JSON.stringify(convId)}); window.__catStatuslineSetOffline(${hasData ? "false" : "true"});`,
  );
}

async function tick() {
  await syncSessions();
  for (const [id, sess] of sessions) {
    try {
      await tickSession(sess);
    } catch (e) {
      sess.close();
      sessions.delete(id);
      console.log("[turn-stats-bar] 页面失效，重连:", id.slice(0, 8), e.message);
    }
  }
}

async function main() {
  console.log(`[turn-stats-bar] 注入器启动，等待 Codex 调试端口 ${CDP_PORT} ...`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.log("[turn-stats-bar] 重试:", e.message);
    }
    // 500ms 切片等待：页面通知“对话已切换”时立即刷新，不等下一次轮询
    const until = Date.now() + POLL_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      if (refreshRequested) {
        refreshRequested = false;
        break;
      }
    }
  }
}

main();
