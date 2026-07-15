#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_PATH=${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}
CODEX_PATH="$APP_PATH/Contents/Resources/codex"
NODE_PATH=${NODE_PATH:-$(command -v node || true)}
BUILD_DIR=${GPT_PATCHER_BUILD_DIR:-"$SCRIPT_DIR/.build"}

if [[ ! -x "$NODE_PATH" ]]; then
  print -u2 "Node.js 20 or newer is required."
  exit 1
fi

version=${CODEX_VERSION:-}
if [[ -z "$version" ]]; then
  if [[ ! -x "$CODEX_PATH" ]]; then
    print -u2 "Cannot find the bundled ChatGPT app-server at: $CODEX_PATH"
    exit 1
  fi
  version_output=$("$CODEX_PATH" --version)
  if [[ "$version_output" != "codex-cli "* ]]; then
    print -u2 "Cannot parse bundled app-server version: $version_output"
    exit 1
  fi
  version=${version_output#codex-cli }
fi

"$NODE_PATH" "$SCRIPT_DIR/build-backend.mjs" "$version" "$BUILD_DIR" "$SCRIPT_DIR"
print "Patched binary: $BUILD_DIR/bin/codex-$version"
