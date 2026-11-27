# Codex Statusbar

在 Codex 桌面版（ChatGPT.app）**输入框上方**常驻一条实时状态栏：模型、生成速度、缓存命中率、上下文占用、Token 与费用。数据按当前对话严格隔离，绝不串号。

```
◉ GLM-5.3-Flash · ⚡≈86 tps · 缓存 99% · ▓上下文 250k/950k 26% · 250k→963 · ⚙工具 63 · 本轮 ¥0.03 · 线程 ¥1.31 · ⚙
```

支持 **macOS** 与 **Windows**。不修改 Codex 本体文件（不受 asar 完整性校验影响），只通过 CDP 注入 DOM。

## 功能

- **CDP 注入状态栏**：body 直属 + fixed 定位（zcode overlay 同款策略），切换对话、页面重渲染都不会丢失
- **对话隔离**：侧边栏选中线程 + 输入框 React fiber 双来源交叉校验，连续两轮确认后才切换；读不到数据显示 `—`
- **实时指标**：模型名（从会话 rollout 读取实际值）、tps 估算、缓存命中率、上下文用量、输入→输出、工具调用次数、本轮/线程费用
- **悬停明细**：鼠标停在任意格子上显示拆分明细（输入/缓存/推理 token、窗口占用、费率说明）
- **配置面板**：状态栏右侧 ⚙ 打开——8 项显示开关、字号 9–18px、数字格式（k/M 或 万/亿），存 localStorage 持久化
- **守护自愈**：watchdog 检测 app 无调试端口自动带参重启（带失败冷却，避免重启循环）；LaunchAgent / 计划任务保活

## 安装

### macOS

依赖：Node.js ≥ 22（内置 WebSocket/fetch，nvm 安装也可）

```bash
git clone <本仓库> codex-statusbar
cd codex-statusbar/scripts/macos
./install.sh
```

脚本做三件事：注册 LaunchAgent（`com.codex.statusbar.watchdog`，开机自启 + 进程守护）→ 若 app 已在跑但无调试端口则优雅退出 → 带参重启并拉起注入器。

卸载：

```bash
./uninstall.sh
```

### Windows

依赖：Node.js ≥ 22、PowerShell

```powershell
git clone <本仓库> codex-statusbar
cd codex-statusbar
powershell -ExecutionPolicy Bypass -File .\scripts\windows\launch-codex-debug.ps1
```

Windows 脚本来自上游 [codex-statusline](https://github.com/yexujinli/codex-statusline)（MSIX 包需 COM 激活传参），守护与自启按上游 watchdog + 计划任务方式接入。**Windows 部分未在 macOS 开发机上实测，如遇问题请参照上游 README 排查。**

## 架构

```
launch-codex-debug（带 --remote-debugging-port=9224 启动 Codex）
        │
        ▼
injector.mjs（常驻 Node 进程）
  ├─ CDP 轮询（2.5s，500ms 切片响应切换通知）
  ├─ 每页面注入 INSTALL_SCRIPT：DOM 状态栏 + React fiber 会话识别
  └─ 数据层：读 ~/.codex/sessions/**/rollout-*.jsonl
       ├─ token_count 事件 → total/last/上下文窗口（大文件只读头 4KB + 尾 512KB）
       ├─ turn_context → 实际模型名
       └─ function_call 计数（全量正则 + mtime 缓存）
```

- Codex 桌面版开启了 `EnableEmbeddedAsarIntegrityValidation`，修改 app.asar 会被拒启动，因此走 CDP 外部注入而非文件篡改
- app 自动升级不影响注入器；若升级后 DOM 结构变化导致选择器失效，需同步更新 `injector.mjs` 内的选择器

## 已知限制

- 费用依赖费率卡 `~/.codex/codex-usage-tracker/kernel-v1/rate-card.json`（不存在时显示 `—`，可手工创建）
- Codex app 必须带调试端口启动；直接点 Dock 图标启动的实例无状态栏，watchdog 会在 60s 内自动带参重启
- 状态栏显示的是 token 用量折算费用，不是账单

## 来源与致谢

- 注入与数据方案基于 [codex-statusline](https://github.com/yexujinli/codex-statusline)（Windows）重构
- 放置策略、配置交互参考 [zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar)
- 指标设计参考 [codex-token-statusbar](https://github.com/Lengbumo/codex-token-statusbar)（悬浮窗版）
