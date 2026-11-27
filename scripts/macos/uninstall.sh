#!/bin/bash
set -eu
UID_N="$(id -u)"
PLIST_DST="$HOME/Library/LaunchAgents/com.codex.statusbar.watchdog.plist"
launchctl bootout gui/$UID_N "$PLIST_DST" 2>/dev/null || true
rm -f "$PLIST_DST"
pkill -f "codex-statusbar/src/injector.mjs" 2>/dev/null || true
echo "uninstalled"
