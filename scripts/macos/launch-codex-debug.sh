#!/bin/bash
# 带 CDP 调试端口启动 ChatGPT(Codex 桌面版) 并拉起 CDP 注入器。幂等。
set -u

CDP_PORT="${TURN_STATS_CDP_PORT:-9224}"
APP_NAME="ChatGPT"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECTOR="$HERE/../../src/injector.mjs"
LOG_DIR="$HERE/../../logs"
mkdir -p "$LOG_DIR"

resolve_node() {
  local p
  if p="$(command -v node 2>/dev/null)" && [ -x "$p" ]; then echo "$p"; return 0; fi
  local latest
  latest="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  if [ -n "$latest" ] && [ -x "$latest" ]; then echo "$latest"; return 0; fi
  local cand
  for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$cand" ] && { echo "$cand"; return 0; }
  done
  return 1
}
NODE_BIN="$(resolve_node || true)"

cdp_alive() { curl -s -m 2 "http://127.0.0.1:${CDP_PORT}/json" >/dev/null 2>&1; }
app_running() { pgrep -f "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" >/dev/null 2>&1; }
injector_running() { pgrep -f "codex-statusbar/src/injector.mjs" >/dev/null 2>&1; }

start_injector() {
  if injector_running; then return 0; fi
  if [ ! -x "$NODE_BIN" ]; then echo "node not found (install Node.js 22+)" >&2; exit 1; fi
  nohup "$NODE_BIN" "$INJECTOR" >>"$LOG_DIR/injector.log" 2>&1 &
  echo "injector started (pid $!)"
}

if cdp_alive; then
  echo "CDP ${CDP_PORT} already alive; ensure injector only"
  start_injector
  exit 0
fi

if app_running; then
  echo "ChatGPT running without debug port; quitting gracefully ..."
  osascript -e 'tell application "ChatGPT" to quit' >/dev/null 2>&1
  for _ in $(seq 1 20); do app_running || break; sleep 0.5; done
  if app_running; then
    echo "app did not quit in 10s; abort to avoid killing with unsaved work" >&2
    exit 1
  fi
fi

echo "launching ChatGPT with --remote-debugging-port=${CDP_PORT} ..."
open -a "$APP_NAME" --args --remote-debugging-port="${CDP_PORT}" --remote-allow-origins=*

ok=0
for _ in $(seq 1 40); do
  if cdp_alive; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != "1" ]; then echo "CDP port did not come up within 20s" >&2; exit 1; fi
echo "CDP ready on ${CDP_PORT}"
start_injector
