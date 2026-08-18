#!/usr/bin/env sh
set -eu
RUNTIME_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CURRENT=$(node -e "const fs=require('fs');const current=String(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).current);if(current==='.'||current==='..'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(current))throw new Error('Agent Hub has no valid current runtime release');console.log(current)" "$RUNTIME_ROOT/current.json")
RELEASE_ROOT=$(node -e "const fs=require('fs');const path=require('path');const releases=fs.realpathSync(process.argv[1]);const release=fs.realpathSync(path.resolve(releases,process.argv[2]));const prefix=releases.endsWith(path.sep)?releases:releases+path.sep;if(!release.startsWith(prefix))throw new Error('Agent Hub runtime release resolves outside releases');console.log(release)" "$RUNTIME_ROOT/releases" "$CURRENT")
node "$RELEASE_ROOT/runtime-manifest-verifier.mjs" "$RELEASE_ROOT" "$CURRENT"
SERVER="$RELEASE_ROOT/agent-hub-main.mjs"
if [ ! -f "$SERVER" ]; then
  echo "Agent Hub entrypoint is missing: $SERVER" >&2
  exit 1
fi
export AGENT_HUB_CONFIG="$RUNTIME_ROOT/config.json"
export AGENT_HUB_LAUNCHER="$RUNTIME_ROOT/launch.sh"
export AGENT_HUB_RUNTIME_ROOT="$RUNTIME_ROOT"
export AGENT_HUB_RELEASE_ID="$CURRENT"
cd "$RELEASE_ROOT"
exec node "$SERVER"
