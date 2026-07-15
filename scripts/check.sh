#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_DIR=${SCRIPT_DIR:h}
PATCH_PATH="$PROJECT_DIR/patches/desktop-hosted-tools.patch"

node --check "$PROJECT_DIR/fixer.mjs"
node --check "$PROJECT_DIR/build-backend.mjs"
zsh -n "$PROJECT_DIR/build.sh"
zsh -n "$PROJECT_DIR/install.sh"
zsh -n "$PROJECT_DIR/uninstall.sh"

for expected in \
  "api_key_custom_provider_uses_hosted_tools_in_standard_responses" \
  "hosted_web_search_and_standalone_image_generation_follow_runtime_gates" \
  "requires_openai_auth" \
  "image_generation_runtime_enabled"
do
  if ! /usr/bin/grep -q "$expected" "$PATCH_PATH"; then
    print -u2 "Patch is missing expected marker: $expected"
    exit 1
  fi
done

for expected in \
  'chatgpt-app-server-${version}' \
  'path.join(SOURCE_DIR, ".build", "bin")'
do
  if ! /usr/bin/grep -Fq "$expected" "$PROJECT_DIR/fixer.mjs" "$PROJECT_DIR/build-backend.mjs"; then
    print -u2 "Desktop app-server cache integration is missing: $expected"
    exit 1
  fi
done

large_file=$(
  find "$PROJECT_DIR" \
    \( \
      -path "$PROJECT_DIR/.git" -o \
      -path "$PROJECT_DIR/.build" -o \
      -path "$PROJECT_DIR/bin" -o \
      -path "$PROJECT_DIR/dist" -o \
      -path "$PROJECT_DIR/node_modules" \
    \) -prune -o -type f -size +100M -print -quit
)
if [[ -n "$large_file" ]]; then
  print -u2 "Repository contains a file larger than 100 MB: $large_file"
  exit 1
fi

if [[ -n "${CODEX_SOURCE_DIR:-}" ]]; then
  git -C "$CODEX_SOURCE_DIR" apply --check "$PATCH_PATH"
  print "Patch applies cleanly to: $CODEX_SOURCE_DIR"
fi

print "Static checks passed."
