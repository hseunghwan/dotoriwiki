#!/bin/zsh
# Installs or refreshes the gateway as a per-user LaunchAgent. Safe to rerun:
# keeps an existing token, rewrites the plist, restarts the service. Never writes
# models.json: without one the gateway runs on the Claude defaults.
set -euo pipefail

APP_DIR=${0:A:h:h}
LABEL=com.cycle.llmwiki-gateway
ENV_FILE=$HOME/.config/llmwiki/gateway.env
MODELS_FILE=$HOME/.config/llmwiki/models.json
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
LOG=$HOME/Library/Logs/llmwiki-gateway.log

WIKI_ROOT=${WIKI_ROOT:-$HOME/llmwiki}
PORT=${PORT:-8787}
# Not $HOST: zsh presets it to the machine's hostname.
LISTEN_HOST=${GATEWAY_HOST:-$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 | head -1)}
NODE_BIN=${NODE_BIN:-$(command -v node)}
CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude)}
# whence -p skips aliases: the interactive codex alias adds --yolo.
CODEX_BIN=${CODEX_BIN:-$(whence -p codex || echo codex)}

mkdir -p ${ENV_FILE:h}
if [[ -f $ENV_FILE ]] && grep -q '^GATEWAY_TOKEN=' $ENV_FILE; then
  TOKEN=$(grep '^GATEWAY_TOKEN=' $ENV_FILE | cut -d= -f2-)
else
  TOKEN=$(openssl rand -hex 24)
fi
umask 077
cat > $ENV_FILE <<EOF
WIKI_ROOT=$WIKI_ROOT
PORT=$PORT
HOST=$LISTEN_HOST
GATEWAY_TOKEN=$TOKEN
CLAUDE_BIN=$CLAUDE_BIN
CODEX_BIN=$CODEX_BIN
MODELS_FILE=$MODELS_FILE
EOF
umask 022

cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>set -a; source "$ENV_FILE"; set +a; exec "$NODE_BIN" src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${NODE_BIN:h}:${CLAUDE_BIN:h}:${CODEX_BIN:h}:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
# bootout returns before the old job is gone; bootstrapping too early fails with EIO.
for _ in {1..20}; do launchctl print gui/$(id -u)/$LABEL >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap gui/$(id -u) $PLIST
echo "installed $LABEL -> http://$LISTEN_HOST:$PORT (wiki: $WIKI_ROOT, log: $LOG)"
[[ -f $MODELS_FILE ]] && echo "models: $MODELS_FILE" || echo "models: Claude defaults (no $MODELS_FILE)"
