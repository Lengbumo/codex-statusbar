#!/bin/bash
# 守护自愈：app 在跑但 CDP 掉线 → 带参重启；注入器掉线 → 重拉。由 LaunchAgent 托管。
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL=15
COOLDOWN=60
FAIL_PAUSE=3
LAST_RESTART=0
FAIL_COUNT=0
LOG="$HERE/../../logs/watchdog.log"
mkdir -p "$HERE/../../logs"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

cdp_alive() { curl -s -m 2 "http://127.0.0.1:${TURN_STATS_CDP_PORT:-9224}/json" >/dev/null 2>&1; }
app_running() { pgrep -f "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" >/dev/null 2>&1; }
injector_running() { pgrep -f "injector.mjs" >/dev/null 2>&1; }

log "watchdog started (pid $$)"
while true; do
  if app_running; then
    now=$(date +%s)
    if ! cdp_alive; then
      if [ $((now - LAST_RESTART)) -ge $COOLDOWN ]; then
        log "app alive but CDP down; relaunching with debug port (fail streak: $FAIL_COUNT)"
        if "$HERE/launch-codex-debug.sh" >>"$LOG" 2>&1; then
          FAIL_COUNT=0
        else
          FAIL_COUNT=$((FAIL_COUNT + 1))
          if [ "$FAIL_COUNT" -ge "$FAIL_PAUSE" ]; then
            log "launch failed $FAIL_COUNT times; pausing 10min to avoid restart loop"
            sleep 600
            FAIL_COUNT=0
          fi
        fi
        LAST_RESTART=$(date +%s)
      fi
    elif ! injector_running; then
      log "injector down; restarting"
      "$HERE/launch-codex-debug.sh" >>"$LOG" 2>&1
    fi
  fi
  sleep "$INTERVAL"
done
