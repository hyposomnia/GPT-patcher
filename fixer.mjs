#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_PATH = process.env.CHATGPT_APP_PATH ?? "/Applications/ChatGPT.app";
const RESOURCES_PATH = path.join(APP_PATH, "Contents", "Resources");
const INFO_PLIST_PATH = path.join(APP_PATH, "Contents", "Info.plist");
const ASAR_PATH = path.join(RESOURCES_PATH, "app.asar");
const BUNDLED_APP_SERVER_PATH = path.join(RESOURCES_PATH, "codex");
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR =
  process.env.CHATGPT_FIXER_STATE_DIR ??
  path.join(os.homedir(), "Library", "Application Support", "ChatGPT Desktop Fixer");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const LOCK_PATH = path.join(STATE_DIR, "maintain.lock");
const CODEX_HOME_PATH = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_HOME_PATH, "config.toml");
const AUTH_PATH = path.join(CODEX_HOME_PATH, "auth.json");
const AGENT_LABEL = "com.local.chatgpt-desktop-fixer";
const AGENT_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${AGENT_LABEL}.plist`,
);
const FRONTEND_OLD = Buffer.from(
  "preserveServerUserMessages:!1,conversationTurns:",
);
const FRONTEND_NEW = Buffer.from(
  "preserveServerUserMessages:!0,conversationTurns:",
);
const SHIM_MARKER = "GPT-patcher lightweight app-server shim v1";
const SHIM_API_KEY_ENV = "GPT_PATCHER_API_KEY";
const ACTOR_AUTHORIZATION_VALUE = "gpt-patcher";

function run(file, args, options = {}) {
  const output = execFileSync(file, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function countMatches(buffer, needle) {
  let count = 0;
  let offset = -1;
  for (;;) {
    offset = buffer.indexOf(needle, offset + 1);
    if (offset < 0) return count;
    count += 1;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporaryPath, STATE_PATH);
}

function hashFile(filePath) {
  const output = run("/usr/bin/shasum", ["-a", "256", filePath]);
  const hash = output.split(/\s+/u)[0];
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`Cannot hash ${filePath}`);
  return hash;
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fileIdentity(filePath) {
  const stat = fs.statSync(filePath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function plistValue(key) {
  return run("/usr/bin/plutil", ["-extract", key, "raw", INFO_PLIST_PATH]);
}

function appIdentity() {
  return {
    build: plistValue("CFBundleVersion"),
    version: plistValue("CFBundleShortVersionString"),
  };
}

function appServerVersion(filePath = BUNDLED_APP_SERVER_PATH, env = process.env) {
  const output = run(filePath, ["--version"], { env });
  const match = output.match(/codex-cli\s+([^\s]+)/u);
  if (match == null) throw new Error(`Cannot parse app-server version at ${filePath}: ${output}`);
  return match[1];
}

function validateAppServer(filePath, version, env = process.env) {
  const actualVersion = appServerVersion(filePath, env);
  if (actualVersion !== version) {
    throw new Error(
      `Unexpected app-server version at ${filePath}: ${actualVersion} (expected ${version})`,
    );
  }
}

function isLightweightShim(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(2048);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(Buffer.from(SHIM_MARKER));
  } finally {
    fs.closeSync(handle);
  }
}

function patchFrontend() {
  const archive = fs.readFileSync(ASAR_PATH);
  const oldCount = countMatches(archive, FRONTEND_OLD);
  const newCount = countMatches(archive, FRONTEND_NEW);

  if (oldCount === 0 && newCount === 1) {
    return { changed: false, status: "patched" };
  }
  if (oldCount !== 1 || newCount !== 0) {
    throw new Error(
      `Frontend patch anchor mismatch (old=${oldCount}, patched=${newCount}); refusing to modify app.asar`,
    );
  }

  const offset = archive.indexOf(FRONTEND_OLD);
  const handle = fs.openSync(ASAR_PATH, "r+");
  try {
    fs.writeSync(handle, FRONTEND_NEW, 0, FRONTEND_NEW.length, offset);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  const verified = fs.readFileSync(ASAR_PATH);
  if (
    countMatches(verified, FRONTEND_OLD) !== 0 ||
    countMatches(verified, FRONTEND_NEW) !== 1
  ) {
    throw new Error("Frontend patch verification failed");
  }
  return { changed: true, offset, status: "patched" };
}

function backupPathForBuild(build) {
  return path.join(STATE_DIR, "backups", build, "codex.original");
}

function resolveOriginalBackend(app, previousState) {
  const backupPath = backupPathForBuild(app.build);
  const bundledHash = hashFile(BUNDLED_APP_SERVER_PATH);
  const bundledIsShim = isLightweightShim(BUNDLED_APP_SERVER_PATH);

  if (fs.existsSync(backupPath)) {
    const backupVersion = appServerVersion(backupPath);
    const backupHash = hashFile(backupPath);
    if (bundledIsShim) {
      return {
        backupHash,
        backupPath,
        bundledHash,
        bundledIsShim,
        version: backupVersion,
      };
    }

    const isKnownLegacyPatch = bundledHash === previousState.patchedBackendHash;
    if (bundledHash !== backupHash && !isKnownLegacyPatch) {
      throw new Error(
        `The bundled app-server differs from both GPT-patcher's backup and known patches for ChatGPT build ${app.build}; refusing to replace it`,
      );
    }
    return {
      backupHash,
      backupPath,
      bundledHash,
      bundledIsShim,
      version: backupVersion,
    };
  }

  if (bundledIsShim) {
    throw new Error(`Lightweight shim found without its original backup: ${backupPath}`);
  }

  const version = appServerVersion(BUNDLED_APP_SERVER_PATH);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(BUNDLED_APP_SERVER_PATH, backupPath);
  fs.chmodSync(backupPath, 0o755);
  validateAppServer(backupPath, version);
  const backupHash = hashFile(backupPath);
  if (backupHash !== bundledHash) throw new Error("Original app-server backup verification failed");
  return { backupHash, backupPath, bundledHash, bundledIsShim, version };
}

function parseTomlString(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  throw new Error(`Expected a quoted TOML string, got: ${rawValue}`);
}

function configuredModelProvider() {
  const override = process.env.GPT_PATCHER_MODEL_PROVIDER;
  let provider = override?.trim();
  const config = fs.readFileSync(CONFIG_PATH, "utf8");

  if (provider == null || provider === "") {
    for (const line of config.split(/\r?\n/u)) {
      if (/^\s*\[/u.test(line)) break;
      const match = line.match(/^\s*model_provider\s*=\s*(.+?)\s*(?:#.*)?$/u);
      if (match != null) {
        provider = parseTomlString(match[1]);
        break;
      }
    }
  }

  if (provider == null || provider === "") {
    throw new Error(
      `Cannot find the root model_provider in ${CONFIG_PATH}; set GPT_PATCHER_MODEL_PROVIDER explicitly`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(provider)) {
    throw new Error(`Unsupported model provider id for the lightweight shim: ${provider}`);
  }
  if (provider === "openai") {
    throw new Error("The lightweight hosted-tools shim is only intended for custom providers");
  }

  const escapedProvider = provider.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const providerTable = new RegExp(
    `^\\s*\\[model_providers\\.${escapedProvider}\\]\\s*(?:#.*)?$`,
    "mu",
  );
  if (!providerTable.test(config)) {
    throw new Error(`Missing [model_providers.${provider}] in ${CONFIG_PATH}`);
  }
  return provider;
}

function hasStoredApiKey() {
  if (process.env[SHIM_API_KEY_ENV]?.trim()) return true;
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    return typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim() !== "";
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`Cannot inspect ${AUTH_PATH}: ${error?.message ?? error}`);
  }
}

function validateCatalog(catalog, source) {
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    throw new Error(`Invalid model catalog at ${source}: models must be a non-empty array`);
  }
  const slugs = new Set();
  for (const model of catalog.models) {
    if (typeof model?.slug !== "string" || model.slug.trim() === "") {
      throw new Error(`Invalid model catalog at ${source}: every model needs a slug`);
    }
    if (slugs.has(model.slug)) {
      throw new Error(`Invalid model catalog at ${source}: duplicate slug ${model.slug}`);
    }
    slugs.add(model.slug);
  }
  return catalog;
}

function readCatalog(filePath) {
  return validateCatalog(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
}

function normalizedCatalogIsValid(filePath) {
  try {
    return readCatalog(filePath).models.every((model) => model.use_responses_lite === false);
  } catch {
    return false;
  }
}

function writeNormalizedCatalog(sourcePath, outputPath) {
  const source = readCatalog(sourcePath);
  const normalized = {
    models: source.models.map((model) => ({ ...model, use_responses_lite: false })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(temporaryPath, outputPath);
  if (!normalizedCatalogIsValid(outputPath)) {
    throw new Error(`Normalized model catalog verification failed: ${outputPath}`);
  }
  return normalized.models.length;
}

function ensureStandardResponsesCatalog(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Unsafe app-server version: ${version}`);
  }
  const outputPath = path.join(
    STATE_DIR,
    "catalogs",
    `models-${version}-standard-responses.json`,
  );
  if (fs.existsSync(outputPath) && normalizedCatalogIsValid(outputPath)) {
    const catalog = readCatalog(outputPath);
    return { hash: hashFile(outputPath), modelCount: catalog.models.length, path: outputPath };
  }

  const sourceCandidates = [
    process.env.GPT_PATCHER_MODEL_CATALOG_SOURCE,
    path.join(SOURCE_DIR, "catalogs", `models-${version}.json`),
    path.join(
      SOURCE_DIR,
      ".build",
      "build",
      `codex-${version}`,
      "codex-rs",
      "models-manager",
      "models.json",
    ),
    path.join(
      STATE_DIR,
      "build",
      `codex-${version}`,
      "codex-rs",
      "models-manager",
      "models.json",
    ),
  ].filter((candidate) => candidate != null && candidate !== "");
  let sourcePath = sourceCandidates.find((candidate) => fs.existsSync(candidate));
  let downloadedPath;
  if (sourcePath == null) {
    downloadedPath = path.join(STATE_DIR, "catalogs", `models-${version}.upstream.json`);
    fs.mkdirSync(path.dirname(downloadedPath), { recursive: true });
    const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/models.json`;
    try {
      run("/usr/bin/curl", [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--output",
        downloadedPath,
        url,
      ]);
    } catch (error) {
      fs.rmSync(downloadedPath, { force: true });
      throw error;
    }
    sourcePath = downloadedPath;
  }

  try {
    const modelCount = writeNormalizedCatalog(sourcePath, outputPath);
    return { hash: hashFile(outputPath), modelCount, path: outputPath };
  } finally {
    if (downloadedPath != null) fs.rmSync(downloadedPath, { force: true });
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function lightweightShimContents(originalBackend, provider, catalogPath) {
  const overrides = [
    `model_providers.${provider}.name="OpenAI"`,
    `model_providers.${provider}.requires_openai_auth=false`,
    `model_providers.${provider}.env_key="${SHIM_API_KEY_ENV}"`,
    `model_providers.${provider}.http_headers.x-openai-actor-authorization="${ACTOR_AUTHORIZATION_VALUE}"`,
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
  ];
  const overrideLines = overrides.map((override) => `  -c ${shellQuote(override)} \\`).join("\n");
  return `#!/bin/zsh
# ${SHIM_MARKER}
set -u

readonly ORIGINAL_BACKEND=${shellQuote(originalBackend)}
codex_home="\${CODEX_HOME:-\${HOME}/.codex}"
auth_json="\${codex_home}/auth.json"

if [[ -z "\${${SHIM_API_KEY_ENV}:-}" && -f "\${auth_json}" ]]; then
  ${SHIM_API_KEY_ENV}=\$(/usr/bin/plutil -extract OPENAI_API_KEY raw -o - "\${auth_json}" 2>/dev/null || true)
  export ${SHIM_API_KEY_ENV}
fi

exec "\${ORIGINAL_BACKEND}" \\
${overrideLines}
  "\$@"
`;
}

function installLightweightShim(originalBackend, provider, catalogPath, version) {
  const contents = Buffer.from(
    lightweightShimContents(originalBackend, provider, catalogPath),
    "utf8",
  );
  const shimHash = hashBuffer(contents);
  if (isLightweightShim(BUNDLED_APP_SERVER_PATH) && hashFile(BUNDLED_APP_SERVER_PATH) === shimHash) {
    return { changed: false, shimHash };
  }

  const temporaryPath = `${BUNDLED_APP_SERVER_PATH}.gpt-patcher-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, contents, { mode: 0o755 });
    fs.chmodSync(temporaryPath, 0o755);
    validateAppServer(temporaryPath, version, {
      ...process.env,
      [SHIM_API_KEY_ENV]: "gpt-patcher-validation-placeholder",
    });
    fs.renameSync(temporaryPath, BUNDLED_APP_SERVER_PATH);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  if (!isLightweightShim(BUNDLED_APP_SERVER_PATH)) {
    throw new Error("Lightweight app-server shim marker verification failed");
  }
  if (hashFile(BUNDLED_APP_SERVER_PATH) !== shimHash) {
    throw new Error("Lightweight app-server shim hash verification failed");
  }
  return { changed: true, shimHash };
}

function notify(title, message) {
  if (process.env.GPT_PATCHER_DISABLE_NOTIFICATIONS === "1") return;
  try {
    run("/usr/bin/osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
  } catch {
    // Notification delivery is best-effort; the LaunchAgent log remains authoritative.
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(LOCK_PATH);
      fs.writeFileSync(path.join(LOCK_PATH, "pid"), `${process.pid}\n`);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let ownerAlive = false;
      let staleOwner = false;
      try {
        const owner = Number.parseInt(
          fs.readFileSync(path.join(LOCK_PATH, "pid"), "utf8").trim(),
          10,
        );
        if (Number.isSafeInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
            ownerAlive = true;
          } catch (processError) {
            if (processError?.code === "EPERM") ownerAlive = true;
            else if (processError?.code === "ESRCH") staleOwner = true;
            else throw processError;
          }
        }
      } catch (lockError) {
        if (lockError?.code === "EPERM") ownerAlive = true;
        if (lockError?.code === "ESRCH") staleOwner = true;
      }
      if (!ownerAlive && !staleOwner) {
        try {
          const ageMs = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
          if (ageMs < 60_000) ownerAlive = true;
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
        }
      }
      if (ownerAlive || attempt > 0) return false;
      fs.rmSync(LOCK_PATH, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseLock() {
  fs.rmSync(LOCK_PATH, { recursive: true, force: true });
}

function maintain() {
  if (!acquireLock()) {
    console.log("ChatGPT Desktop Fixer is already running.");
    return;
  }

  try {
    for (const requiredPath of [
      INFO_PLIST_PATH,
      ASAR_PATH,
      BUNDLED_APP_SERVER_PATH,
      CONFIG_PATH,
    ]) {
      if (!fs.existsSync(requiredPath)) throw new Error(`Missing ChatGPT file: ${requiredPath}`);
    }

    const previousState = readState();
    const app = appIdentity();
    const currentAsarIdentity = fileIdentity(ASAR_PATH);
    const currentBackendIdentity = fileIdentity(BUNDLED_APP_SERVER_PATH);
    const currentConfigIdentity = fileIdentity(CONFIG_PATH);
    const currentBackendIsShim = isLightweightShim(BUNDLED_APP_SERVER_PATH);
    if (
      previousState.backendMode === "lightweight-shim" &&
      previousState.appBuild === app.build &&
      previousState.asarSize === currentAsarIdentity.size &&
      previousState.asarMtimeMs === currentAsarIdentity.mtimeMs &&
      previousState.backendSize === currentBackendIdentity.size &&
      previousState.backendMtimeMs === currentBackendIdentity.mtimeMs &&
      previousState.configSize === currentConfigIdentity.size &&
      previousState.configMtimeMs === currentConfigIdentity.mtimeMs &&
      currentBackendIsShim &&
      hashFile(BUNDLED_APP_SERVER_PATH) === previousState.shimHash
    ) {
      console.log(`ChatGPT ${app.version} (${app.build}) is already patched in lightweight mode.`);
      return;
    }

    if (!currentBackendIsShim && !hasStoredApiKey()) {
      throw new Error(
        `Refusing the first lightweight install without OPENAI_API_KEY in ${AUTH_PATH} or ${SHIM_API_KEY_ENV} in the environment`,
      );
    }

    const provider = configuredModelProvider();
    const original = resolveOriginalBackend(app, previousState);
    const catalog = ensureStandardResponsesCatalog(original.version);

    const appAfterPreparation = appIdentity();
    if (
      appAfterPreparation.build !== app.build ||
      appAfterPreparation.version !== app.version
    ) {
      throw new Error(
        `ChatGPT changed during lightweight patch preparation (${app.version}/${app.build} -> ${appAfterPreparation.version}/${appAfterPreparation.build}); retrying on the next maintenance run`,
      );
    }
    if (hashFile(BUNDLED_APP_SERVER_PATH) !== original.bundledHash) {
      throw new Error("Bundled app-server changed during lightweight patch preparation");
    }
    const configBeforeInstall = fileIdentity(CONFIG_PATH);
    if (
      configBeforeInstall.size !== currentConfigIdentity.size ||
      configBeforeInstall.mtimeMs !== currentConfigIdentity.mtimeMs
    ) {
      throw new Error("Codex config changed during lightweight patch preparation");
    }

    const frontend = patchFrontend();
    const appBeforeInstall = appIdentity();
    if (
      appBeforeInstall.build !== app.build ||
      appBeforeInstall.version !== app.version ||
      hashFile(BUNDLED_APP_SERVER_PATH) !== original.bundledHash
    ) {
      throw new Error("ChatGPT changed while applying the frontend patch; refusing backend install");
    }
    const backend = installLightweightShim(
      original.backupPath,
      provider,
      catalog.path,
      original.version,
    );
    const asarIdentity = fileIdentity(ASAR_PATH);
    const backendIdentity = fileIdentity(BUNDLED_APP_SERVER_PATH);
    const configIdentity = fileIdentity(CONFIG_PATH);
    const nextState = {
      appBuild: app.build,
      appVersion: app.version,
      asarMtimeMs: asarIdentity.mtimeMs,
      asarSize: asarIdentity.size,
      backendMode: "lightweight-shim",
      backendMtimeMs: backendIdentity.mtimeMs,
      backendSize: backendIdentity.size,
      backendVersion: original.version,
      catalogHash: catalog.hash,
      catalogModelCount: catalog.modelCount,
      catalogPath: catalog.path,
      configMtimeMs: configIdentity.mtimeMs,
      configSize: configIdentity.size,
      frontendStatus: frontend.status,
      frontendOffset: frontend.offset ?? previousState.frontendOffset ?? null,
      modelProvider: provider,
      originalBackendHash: original.backupHash,
      originalBackendPath: original.backupPath,
      shimHash: backend.shimHash,
      updatedAt: new Date().toISOString(),
    };
    writeState(nextState);

    console.log(
      JSON.stringify(
        {
          ...nextState,
          backendChanged: backend.changed,
          frontendChanged: frontend.changed,
        },
        null,
        2,
      ),
    );
    if (backend.changed || frontend.changed) {
      notify(
        "ChatGPT Desktop Fixer",
        `Patched ChatGPT ${app.version} (${app.build}) with the lightweight shim. Restart ChatGPT to load the fixes.`,
      );
    }
  } catch (error) {
    notify("ChatGPT Desktop Fixer failed", String(error?.message ?? error));
    throw error;
  } finally {
    releaseLock();
  }
}

function restore() {
  const state = readState();
  const app = appIdentity();
  const backupPath = backupPathForBuild(app.build);
  let backendRestore;
  if (fs.existsSync(backupPath)) {
    const currentHash = hashFile(BUNDLED_APP_SERVER_PATH);
    const backupHash = hashFile(backupPath);
    const currentIsManaged =
      isLightweightShim(BUNDLED_APP_SERVER_PATH) ||
      currentHash === state.shimHash ||
      currentHash === state.patchedBackendHash;
    if (!currentIsManaged && currentHash !== backupHash) {
      throw new Error(
        "The bundled app-server is not managed by GPT-patcher and differs from its backup; refusing to overwrite it",
      );
    }
    backendRestore = { backupHash, backupPath, currentIsManaged };
  }

  const archive = fs.readFileSync(ASAR_PATH);
  const oldCount = countMatches(archive, FRONTEND_OLD);
  const newCount = countMatches(archive, FRONTEND_NEW);
  if (oldCount === 0 && newCount === 1) {
    const offset = archive.indexOf(FRONTEND_NEW);
    const handle = fs.openSync(ASAR_PATH, "r+");
    try {
      fs.writeSync(handle, FRONTEND_OLD, 0, FRONTEND_OLD.length, offset);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } else if (!(oldCount === 1 && newCount === 0)) {
    throw new Error(
      `Frontend restore anchor mismatch (original=${oldCount}, patched=${newCount})`,
    );
  }

  if (backendRestore?.currentIsManaged) {
    const temporaryPath = `${BUNDLED_APP_SERVER_PATH}.desktop-fixer-restore-${process.pid}`;
    fs.copyFileSync(backendRestore.backupPath, temporaryPath);
    fs.chmodSync(temporaryPath, 0o755);
    fs.renameSync(temporaryPath, BUNDLED_APP_SERVER_PATH);
    if (hashFile(BUNDLED_APP_SERVER_PATH) !== backendRestore.backupHash) {
      throw new Error("Original app-server restore verification failed");
    }
  }
  writeState({ ...state, backendMode: "restored", restoredAt: new Date().toISOString() });
  console.log("Restored the current ChatGPT build. Restart ChatGPT to reload it.");
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function launchAgentNodePath() {
  const candidates = [
    process.env.CHATGPT_FIXER_NODE_PATH,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for a stable executable path.
    }
  }
  throw new Error("Cannot find an executable Node.js runtime for the LaunchAgent");
}

function install() {
  const provider = configuredModelProvider();
  if (!hasStoredApiKey()) {
    throw new Error(
      `Lightweight mode needs an existing OPENAI_API_KEY in ${AUTH_PATH} or ${SHIM_API_KEY_ENV} in the environment`,
    );
  }

  const installedProgramDir = path.join(STATE_DIR, "program");
  fs.mkdirSync(installedProgramDir, { recursive: true });
  fs.copyFileSync(path.join(SOURCE_DIR, "fixer.mjs"), path.join(installedProgramDir, "fixer.mjs"));

  fs.mkdirSync(path.dirname(AGENT_PATH), { recursive: true });
  const installedFixer = path.join(installedProgramDir, "fixer.mjs");
  const logPath = path.join(STATE_DIR, "maintain.log");
  const nodePath = launchAgentNodePath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(installedFixer)}</string>
    <string>maintain</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>WatchPaths</key>
  <array>
    <string>${xmlEscape(INFO_PLIST_PATH)}</string>
    <string>${xmlEscape(ASAR_PATH)}</string>
    <string>${xmlEscape(BUNDLED_APP_SERVER_PATH)}</string>
    <string>${xmlEscape(CONFIG_PATH)}</string>
  </array>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
  fs.writeFileSync(AGENT_PATH, plist);

  const domain = `gui/${process.getuid()}`;
  try {
    run("/bin/launchctl", ["bootout", domain, AGENT_PATH]);
  } catch {
    // The agent may not have been installed before.
  }
  maintain();
  run("/bin/launchctl", ["bootstrap", domain, AGENT_PATH]);
  console.log(`Installed ${AGENT_LABEL} for custom provider ${provider} at ${AGENT_PATH}`);
}

function uninstall() {
  const domain = `gui/${process.getuid()}`;
  try {
    run("/bin/launchctl", ["bootout", domain, AGENT_PATH]);
  } catch {
    // Already unloaded.
  }
  fs.rmSync(AGENT_PATH, { force: true });
  console.log(`Uninstalled ${AGENT_LABEL}. Run restore first to undo the current patch.`);
}

function cleanupLegacyArtifacts() {
  const candidates = [
    path.join(STATE_DIR, "bin"),
    path.join(STATE_DIR, "build"),
    path.join(STATE_DIR, "build-home"),
    path.join(STATE_DIR, "program", "build-backend.mjs"),
    path.join(STATE_DIR, "program", "patches"),
  ];
  if (process.env.GPT_PATCHER_CLEAN_LOCAL_BUILD === "1") {
    candidates.push(path.join(SOURCE_DIR, ".build"), path.join(SOURCE_DIR, "bin"));
  }
  const removed = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    fs.rmSync(candidate, { force: true, recursive: true });
    removed.push(candidate);
  }
  console.log(JSON.stringify({ removed }, null, 2));
}

function status() {
  const archive = fs.readFileSync(ASAR_PATH);
  const state = readState();
  console.log(
    JSON.stringify(
      {
        app: appIdentity(),
        backendHash: hashFile(BUNDLED_APP_SERVER_PATH),
        backendIsLightweightShim: isLightweightShim(BUNDLED_APP_SERVER_PATH),
        configPath: CONFIG_PATH,
        frontendOriginalAnchors: countMatches(archive, FRONTEND_OLD),
        frontendPatchedAnchors: countMatches(archive, FRONTEND_NEW),
        launchAgentInstalled: fs.existsSync(AGENT_PATH),
        state,
      },
      null,
      2,
    ),
  );
}

const command = process.argv[2] ?? "status";
switch (command) {
  case "maintain":
  case "apply":
    maintain();
    break;
  case "install":
    install();
    break;
  case "restore":
    restore();
    break;
  case "status":
    status();
    break;
  case "uninstall":
    uninstall();
    break;
  case "cleanup":
    cleanupLegacyArtifacts();
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
