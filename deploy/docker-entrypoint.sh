#!/usr/bin/env sh
set -eu

mkdir -p "$HOME/.config/opencode" "$HOME/.local/share/opencode"

if [ ! -f "$HOME/.config/opencode/opencode.json" ]; then
  cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "minimax-coding-plan/MiniMax-M3",
  "provider": {
    "minimax-coding-plan": {
      "models": {
        "MiniMax-M3": {
          "name": "MiniMax M3",
          "limit": {
            "context": 1000000,
            "output": 65536
          }
        }
      }
    },
    "minimax": {
      "models": {
        "MiniMax-M3": {
          "name": "MiniMax M3",
          "limit": {
            "context": 1000000,
            "output": 65536
          }
        }
      }
    }
  }
}
JSON
fi

if [ -n "${MINIMAX_API_KEY:-}" ]; then
  node <<'NODE'
const fs = require('fs');
const path = require('path');
const authPath = path.join(process.env.HOME || '/home/open-design', '.local/share/opencode/auth.json');
let auth = {};
try { auth = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
let changed = false;
for (const id of ['minimax-coding-plan', 'minimax']) {
  if (!auth[id]?.key) {
    auth[id] = { type: 'api', key: process.env.MINIMAX_API_KEY };
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
  fs.chmodSync(authPath, 0o600);
}
NODE
fi

exec node apps/daemon/dist/cli.js --no-open
