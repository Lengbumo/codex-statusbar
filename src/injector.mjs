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
  var VERSION = 11;
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
      '#cat-statusline{position:fixed;left:12px;right:12px;bottom:6px;display:flex;align-items:center;padding:4px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;line-height:1.6;color:var(--color-token-text-secondary,#9aa1aa);white-space:nowrap;overflow:hidden;background:color-mix(in srgb,var(--color-token-bg-primary,#ffffff) 88%,transparent);backdrop-filter:blur(8px);border:1px solid color-mix(in srgb,var(--color-token-border,rgba(128,128,128,.3)) 60%,transparent);border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08);user-select:none;z-index:2147483000;transition:bottom .15s ease}' + '#cat-statusline #cat-statusline-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
      '#cat-statusline .csl-off{opacity:.55}' +
      '#cat-statusline .csl-seg{display:inline-flex;align-items:baseline;gap:3px}' +
      '#cat-statusline .csl-ico{opacity:.7;font-size:.92em}' +
      '#cat-statusline .csl-lbl{opacity:.5;font-size:.92em}' +
      '#cat-statusline .csl-val{font-weight:600;color:var(--color-token-text-primary,#e6e8eb)}' +
      '#cat-statusline .csl-dot{opacity:.4;margin:0 7px}' +
      '#cat-statusline .csl-model .csl-val{color:#7fb8ff}' +
      '#cat-statusline .csl-ctx .csl-val{color:#4ade80}' +
      '#cat-statusline .csl-warn .csl-val{color:#f0b429}' +
      '#cat-statusline .csl-danger .csl-val{color:#ff6b6b}' +
      '#cat-statusline .csl-turn .csl-val{color:#b8a8ff}' +
      '#cat-statusline .csl-tools .csl-val{color:#7bd4a8}' +
      '#cat-statusline .csl-gear{cursor:pointer;opacity:.5;margin-left:8px}' +
      '#cat-statusline .csl-gear:hover{opacity:1}' +
      '#cat-statusline-settings{position:fixed;right:16px;bottom:110px;z-index:2147483001;background:var(--color-token-bg-primary,#ffffff);border:1px solid color-mix(in srgb,var(--color-token-border,rgba(128,128,128,.4)) 70%,transparent);border-radius:10px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:170px}' +
      '#cat-statusline-settings .csl-panel-title{font-weight:600;margin-bottom:4px;color:var(--color-token-text-primary,#1d1f24)}' +
      '#cat-statusline-settings label{display:flex;align-items:center;gap:6px;color:var(--color-token-text-secondary,#3d4350);cursor:pointer}' +
      '#cat-statusline-settings input[type=number]{width:52px;background:transparent;border:1px solid rgba(128,128,128,.4);border-radius:6px;color:var(--color-token-text-primary,#1d1f24);padding:2px 4px}' +
      '#cat-statusline-settings button{margin-top:6px;background:#2c6ecb;border:none;border-radius:6px;color:#fff;padding:4px 0;cursor:pointer;font-size:12px}';
    (document.head || document.documentElement).appendChild(st);
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
    // 位置：跟随输入框上方；输入框不存在（首页/设置）时贴窗口底部
    var host = composerHost();
    if (host) {
      var r = host.getBoundingClientRect();
      node.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 320)) + 'px';
      node.style.right = 'auto';
      node.style.width = 'auto';
      node.style.maxWidth = (window.innerWidth - 24) + 'px';
      node.style.bottom = Math.max(6, window.innerHeight - r.top + 4) + 'px';
    } else {
      node.style.left = '12px';
      node.style.right = '12px';
      node.style.width = 'auto';
      node.style.bottom = '6px';
    }
  }

  window.__catStatuslineEnsure = ensure;
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cslConf() {
    var d = { show: { model: 1, tps: 1, cache: 1, ctx: 1, tokens: 1, tools: 1, turnCost: 1, threadCost: 1 }, fontSize: 12, fmt: 'k' };
    try {
      var c = JSON.parse(localStorage.getItem('cat-statusline-config') || '{}');
      if (c.show) for (var k in d.show) if (k in c.show) d.show[k] = !!c.show[k];
      if (c.fontSize) d.fontSize = Math.min(18, Math.max(9, parseInt(c.fontSize, 10) || 12));
      if (c.fmt) d.fmt = c.fmt === "cn" ? "cn" : "k";
    } catch (e) {}
    return d;
  }

  var CSL_ITEMS = [
    ['model', '模型'], ['tps', '生成速度'], ['cache', '缓存'], ['ctx', '上下文'],
    ['tokens', '输入→输出'], ['tools', '工具调用'], ['turnCost', '本轮费用'], ['threadCost', '线程费用'],
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
        + (p.icon ? '<span class="csl-ico">' + escapeHtml(p.icon) + '</span>' : '')
        + (p.label ? '<span class="csl-lbl">' + escapeHtml(p.label) + '</span>' : '')
        + '<span class="csl-val">' + escapeHtml(p.text) + '</span></span>'
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
    var a = sidebarConvId();
    var b = fiberConvId();
    if (a && b) return a === b ? a : null;
    return a || b || null;
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
function scanExtras(convId) {
  const entry = loadRollout(convId);
  if (!entry?.path) return null;
  let st;
  try { st = statSync(entry.path); } catch { return null; }
  const cached = extrasCache.get(convId);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
  const data = { model: null, toolCalls: 0 };
  try {
    const raw = readFileSync(entry.path, "utf8");
    const models = raw.match(/"model"\s*:\s*"([^"]+)"/g);
    if (models && models.length) {
      const mm = /"model"\s*:\s*"([^"]+)"/.exec(models[models.length - 1]);
      if (mm) data.model = mm[1];
    }
    const calls = raw.match(/"type"\s*:\s*"function_call"/g);
    data.toolCalls = calls ? calls.length : 0;
  } catch { /* 读取失败保持空数据 */ }
  extrasCache.set(convId, { mtimeMs: st.mtimeMs, data });
  return data;
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

function fmtCny(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n === 0) return "¥0";
  if (n < 0.01) return "≈¥" + n.toFixed(5);
  return "¥" + n.toFixed(2);
}

function costOf(usage, rates, modelName) {
  if (!usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  if (input === 0 && output === 0) return null;
  const r = rates[modelName] || rates[DEFAULT_MODEL] || {};
  const inRateRaw = Number(r.input_per_million);
  const cachedRateRaw = Number(r.cached_input_per_million);
  const outRateRaw = Number(r.output_per_million);
  const inRate = Number.isFinite(inRateRaw) ? inRateRaw : 1;
  const cachedRate = Number.isFinite(cachedRateRaw) ? cachedRateRaw : 0.02;
  const outRate = Number.isFinite(outRateRaw) ? outRateRaw : 2;
  return ((input - cached) * inRate + cached * cachedRate + output * outRate) / 1e6;
}

function cachePct(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  if (input <= 0) return null;
  return (100 * cached) / input;
}

function buildLine(convId, ctx, tps, rates, fmt) {
  const entry = convId ? loadRollout(convId) : null;
  const rollout = entry?.path ?? null;
  let parsed = entry?.parsed ?? { total: null, last: null, contextWindow: null, sessionId: null };
  // 严格身份校验：文件内 session_meta.id 必须等于当前对话，否则按无数据处理
  if (parsed.sessionId && parsed.sessionId !== convId) {
    parsed = { total: null, last: null, contextWindow: null, sessionId: null };
  }
  const extras = convId ? scanExtras(convId) : null;
  const modelName = extras?.model || DEFAULT_MODEL;
  const last = parsed.last || {};
  const total = parsed.total || {};
  // 上下文兜底：最新请求输入量 ≈ 当前上下文已用，窗口取 token_count 的 model_context_window
  const ctxUsed = ctx?.used ?? (Number(last.input_tokens) > 0 ? Number(last.input_tokens) : null);
  const ctxWin = ctx?.win ?? (Number(parsed.contextWindow) > 0 ? Number(parsed.contextWindow) : null);
  const effCtx = ctxUsed !== null && ctxWin !== null ? { used: ctxUsed, win: ctxWin } : ctx;
  const cache = cachePct(last);
  const costLast = costOf(last, rates, modelName);
  const costTotal = costOf(total, rates, modelName);
  const hasLast = (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0) > 0;

  const hasData = !!(convId && rollout && last.input_tokens);
  if (!hasData) {
    const wait = convId ? (rollout ? "等待首次统计…" : "等待首个请求…") : null;
    return { parts: wait ? [{ key: "wait", text: wait }] : [], hasData };
  }

  const cachedIn = Number(last.cached_input_tokens) || 0;
  const reasoning = Number(last.reasoning_output_tokens) || 0;
  const detailOf = {
    model: `费率按费率卡 ${modelName} 计算`,
    tps: "输出 token 生成速率，空闲时冻结最后值",
    cache: cache === null ? "暂无缓存数据" : `缓存命中率 = 缓存读取 ${fmtK(cachedIn, fmt)} / 输入 ${fmtK(Number(last.input_tokens) || 0, fmt)}`,
    tools: `本会话工具调用 ${extras?.toolCalls ?? 0} 次`,
    turnCost: costLast === null ? "费率卡未配置该模型" : `最近一次请求费用（费率卡：${modelName}）`,
    threadCost: costTotal === null ? "费率卡未配置该模型" : `当前对话累计费用（费率卡：${modelName}）`,
  };
  const parts = [
    { key: "model", icon: "◉", label: "", text: modelName, cls: "csl-model", detail: detailOf.model },
    { key: "tps", icon: "⚡", label: "", text: tps ? `≈${tps} tps` : "—", cls: "csl-tps", detail: detailOf.tps },
    { key: "cache", icon: "", label: "缓存", text: cache === null ? "—" : Math.round(cache) + "%", cls: "csl-cache", detail: detailOf.cache },
  ];
  if (effCtx && effCtx.win) {
    const used = Number(effCtx.used) || 0;
    const win = Number(effCtx.win) || 0;
    const pct = win > 0 ? (100 * used) / win : null;
    const pctTxt = pct === null ? "—" : Math.round(pct) + "%";
    const cls = pct !== null && pct > 90 ? "csl-danger" : pct !== null && pct > 70 ? "csl-warn" : "csl-ctx";
    parts.push({
      key: "ctx", icon: "▓", label: "上下文", cls,
      text: `${fmtK(used, fmt)}/${fmtK(win, fmt)} ${pctTxt}`,
      detail: `窗口 ${fmtK(win, fmt)} · 已用 ${fmtK(used, fmt)}（${pctTxt}）`,
    });
  } else {
    parts.push({ key: "ctx", icon: "▓", label: "上下文", text: "—/—", cls: "csl-ctx", detail: "暂无上下文数据" });
  }
  parts.push({
    key: "tokens",
    icon: "",
    label: "",
    cls: "csl-tokens",
    text: hasLast ? `${fmtK(last.input_tokens || 0, fmt)}→${fmtK(last.output_tokens || 0, fmt)}` : "—→—",
    detail: hasLast ? `输入 ${fmtK(last.input_tokens || 0, fmt)}（缓存 ${fmtK(cachedIn, fmt)}）→ 输出 ${fmtK(last.output_tokens || 0, fmt)}（含推理 ${fmtK(reasoning, fmt)}）` : "暂无 token 统计",
  });
  parts.push({ key: "tools", icon: "⚙", label: "工具", text: String(extras?.toolCalls ?? 0), cls: "csl-tools", detail: detailOf.tools });
  parts.push({ key: "turnCost", icon: "", label: "本轮", text: fmtCny(costLast), cls: "csl-turn", detail: detailOf.turnCost });
  parts.push({ key: "threadCost", icon: "", label: "线程", text: fmtCny(costTotal), cls: "csl-thread", detail: detailOf.threadCost });
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
    sock.onopen = () => resolve(sock);
    sock.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
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
  return (list || []).filter(
    (t) => t.type === "page" && !/avatar-overlay|initialRoute/.test(t.url || ""),
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
