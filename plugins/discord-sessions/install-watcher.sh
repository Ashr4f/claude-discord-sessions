#!/usr/bin/env bash
# Install the Discord wake-on-message watcher as an autostart service.
# Linux: systemd user unit. macOS: launchd agent. (Windows uses Task
# Scheduler + watcher.vbs — see FOR-CLAUDE.md.)
set -euo pipefail

DIR="$HOME/.claude/channels/discord"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

if [ ! -x "$BUN" ]; then
    echo "bun not found — install it first (https://bun.sh)" >&2
    exit 1
fi

case "$(uname -s)" in
Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat >"$UNIT_DIR/claude-discord-watcher.service" <<EOF
[Unit]
Description=Claude Discord wake-on-message watcher

[Service]
ExecStart=$BUN $DIR/watcher.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now claude-discord-watcher.service
    echo "installed + started (systemd user unit claude-discord-watcher)"
    echo "logs: $DIR/watcher-log.txt or journalctl --user -u claude-discord-watcher"
    ;;
Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.claude.discord-watcher.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.claude.discord-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN</string>
        <string>$DIR/watcher.mjs</string>
    </array>
    <key>KeepAlive</key><true/>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "installed + started (launchd agent com.claude.discord-watcher)"
    echo "logs: $DIR/watcher-log.txt"
    ;;
*)
    echo "unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
