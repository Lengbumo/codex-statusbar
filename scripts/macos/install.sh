#!/bin/bash
# 一键安装：注册 LaunchAgent（开机自启 + 进程守护）并立即拉起状态栏。
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="$HERE/com.codex.statusbar.watchdog.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.codex.statusbar.watchdog.plist"
UID_N="$(id -u)"

sed "s|__STATUSBAR_DIR__|$(cd "$HERE/../.." && pwd)|g" "$PLIST_SRC" > "$PLIST_DST"
launchctl bootout gui/$UID_N "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap gui/$UID_N "$PLIST_DST"
echo "LaunchAgent installed: com.codex.statusbar.watchdog"
sleep 2
"$HERE/launch-codex-debug.sh"
