#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
NODE_PATH=${NODE_PATH:-$(command -v node || true)}

if [[ ! -x "$NODE_PATH" ]]; then
  print -u2 "Node.js not found"
  exit 1
fi

"$NODE_PATH" "$SCRIPT_DIR/fixer.mjs" restore
exec "$NODE_PATH" "$SCRIPT_DIR/fixer.mjs" uninstall
