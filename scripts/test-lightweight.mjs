#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-patcher-test-"));
const appPath = path.join(temporaryDir, "ChatGPT Test.app");
const resourcesPath = path.join(appPath, "Contents", "Resources");
const codexHome = path.join(temporaryDir, "codex-home");
const stateDir = path.join(temporaryDir, "state");
const originalBackend = `#!/bin/zsh
for argument in "$@"; do
  if [[ "$argument" == "--version" ]]; then
    print "codex-cli 0.144.2"
    exit 0
  fi
  if [[ "$argument" == "--dump-shim" ]]; then
    print "\${GPT_PATCHER_API_KEY:-}|$*"
    exit 0
  fi
done
exit 0
`;

fs.mkdirSync(resourcesPath, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(
  path.join(appPath, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleVersion</key><string>test-build</string>
<key>CFBundleShortVersionString</key><string>test-version</string>
</dict></plist>
`,
);
fs.writeFileSync(
  path.join(resourcesPath, "app.asar"),
  "prefix-preserveServerUserMessages:!1,conversationTurns:-suffix",
);
fs.writeFileSync(path.join(resourcesPath, "codex"), originalBackend, { mode: 0o755 });
fs.chmodSync(path.join(resourcesPath, "codex"), 0o755);
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  `model = "test-model"
model_provider = "custom"

[model_providers.custom]
name = "Test provider"
base_url = "https://example.invalid/v1"
wire_api = "responses"
requires_openai_auth = true
`,
);
fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"test-key"}\n');
const catalogSource = path.join(temporaryDir, "models.json");
fs.writeFileSync(
  catalogSource,
  `${JSON.stringify({ models: [{ slug: "test-model", use_responses_lite: true }] })}\n`,
);

const env = {
  ...process.env,
  CHATGPT_APP_PATH: appPath,
  CHATGPT_FIXER_STATE_DIR: stateDir,
  CODEX_HOME: codexHome,
  GPT_PATCHER_DISABLE_NOTIFICATIONS: "1",
  GPT_PATCHER_MODEL_CATALOG_SOURCE: catalogSource,
};

function fixer(command) {
  return execFileSync(process.execPath, [path.join(projectDir, "fixer.mjs"), command], {
    encoding: "utf8",
    env,
  });
}

try {
  const firstApply = fixer("apply");
  const shimPath = path.join(resourcesPath, "codex");
  const shim = fs.readFileSync(shimPath, "utf8");
  assert.match(shim, /GPT-patcher lightweight app-server shim v1/u);
  assert.ok(Buffer.byteLength(shim) < 4096, "shim should stay below 4 KiB");
  assert.match(shim, /x-openai-actor-authorization/u);
  assert.match(firstApply, /"backendMode": "lightweight-shim"/u);

  const version = execFileSync(shimPath, ["--version"], { encoding: "utf8", env }).trim();
  assert.equal(version, "codex-cli 0.144.2");
  const shimInvocation = execFileSync(shimPath, ["--dump-shim"], {
    encoding: "utf8",
    env,
  }).trim();
  assert.match(shimInvocation, /^test-key\|/u);
  assert.match(shimInvocation, /model_providers\.custom\.requires_openai_auth=false/u);
  assert.match(shimInvocation, /x-openai-actor-authorization/u);
  assert.match(shimInvocation, /model_catalog_json=/u);
  const normalizedCatalog = JSON.parse(
    fs.readFileSync(
      path.join(stateDir, "catalogs", "models-0.144.2-standard-responses.json"),
      "utf8",
    ),
  );
  assert.equal(normalizedCatalog.models[0].use_responses_lite, false);

  assert.match(fixer("apply"), /already patched in lightweight mode/u);
  fixer("restore");
  assert.equal(fs.readFileSync(shimPath, "utf8"), originalBackend);
  assert.match(
    fs.readFileSync(path.join(resourcesPath, "app.asar"), "utf8"),
    /preserveServerUserMessages:!1/u,
  );
  console.log("Lightweight shim integration test passed.");
} finally {
  fs.rmSync(temporaryDir, { force: true, recursive: true });
}
