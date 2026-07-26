#!/usr/bin/env sh
set -eu
RUNTIME_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CURRENT=$(node -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).current)" "$RUNTIME_ROOT/current.json")
RELEASE_ROOT="$RUNTIME_ROOT/releases/$CURRENT"
SERVER="$RELEASE_ROOT/agent-hub-server.mjs"
if [ ! -f "$SERVER" ]; then SERVER="$RELEASE_ROOT/bot.mjs"; fi
export AGENT_HUB_CONFIG="$RUNTIME_ROOT/config.json"
export TELEGRAM_CODEX_CONFIG="$AGENT_HUB_CONFIG"
export AGENT_HUB_LAUNCHER="$RUNTIME_ROOT/launch.sh"
export TELEGRAM_INTEGRATION_LAUNCHER="$AGENT_HUB_LAUNCHER"
export AGENT_HUB_RUNTIME_ROOT="$RUNTIME_ROOT"
export TELEGRAM_INTEGRATION_RUNTIME_ROOT="$AGENT_HUB_RUNTIME_ROOT"
cd "$RELEASE_ROOT"
exec node "$SERVER"
