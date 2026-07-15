#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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

function bundledAppServerVersion() {
  const output = run(BUNDLED_APP_SERVER_PATH, ["--version"]);
  const match = output.match(/codex-cli\s+([^\s]+)/u);
  if (match == null) throw new Error(`Cannot parse bundled app-server version: ${output}`);
  return match[1];
}

function validatePatchedBackend(filePath, version) {
  const output = run(filePath, ["--version"]);
  if (output !== `codex-cli ${version}`) {
    throw new Error(`Unexpected cached app-server version at ${filePath}: ${output}`);
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

function ensurePatchedBackend(version) {
  const outputPath = path.join(STATE_DIR, "bin", `chatgpt-app-server-${version}`);
  const legacyOutputPath = path.join(STATE_DIR, "bin", `codex-${version}`);
  if (!fs.existsSync(outputPath) && fs.existsSync(legacyOutputPath)) {
    try {
      validatePatchedBackend(legacyOutputPath, version);
      fs.renameSync(legacyOutputPath, outputPath);
    } catch (error) {
      console.warn(String(error?.message ?? error));
      fs.rmSync(legacyOutputPath, { force: true });
    }
  }
  if (fs.existsSync(outputPath)) {
    try {
      validatePatchedBackend(outputPath, version);
      return outputPath;
    } catch (error) {
      console.warn(String(error?.message ?? error));
      fs.rmSync(outputPath, { force: true });
    }
  }

  const builderPath = path.join(SOURCE_DIR, "build-backend.mjs");
  run(process.execPath, [builderPath, version, STATE_DIR, SOURCE_DIR], {
    stdio: "inherit",
  });
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Backend builder did not create ${outputPath}`);
  }
  validatePatchedBackend(outputPath, version);
  return outputPath;
}

function installBackend(patchedBackend, app, previousState) {
  const patchedHash = hashFile(patchedBackend);
  const bundledHash = hashFile(BUNDLED_APP_SERVER_PATH);
  if (bundledHash === patchedHash) {
    return { changed: false, patchedHash };
  }

  const backupDir = path.join(STATE_DIR, "backups", app.build);
  const backupPath = path.join(backupDir, "codex.original");
  fs.mkdirSync(backupDir, { recursive: true });
  if (!fs.existsSync(backupPath)) {
    const wasPreviousPatch = bundledHash === previousState.patchedBackendHash;
    if (!wasPreviousPatch) fs.copyFileSync(BUNDLED_APP_SERVER_PATH, backupPath);
  }

  const temporaryPath = `${BUNDLED_APP_SERVER_PATH}.desktop-fixer-${process.pid}`;
  fs.copyFileSync(patchedBackend, temporaryPath);
  fs.chmodSync(temporaryPath, 0o755);
  fs.renameSync(temporaryPath, BUNDLED_APP_SERVER_PATH);
  if (hashFile(BUNDLED_APP_SERVER_PATH) !== patchedHash) {
    throw new Error("Bundled app-server verification failed after replacement");
  }
  return { changed: true, patchedHash };
}

function notify(title, message) {
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
    for (const requiredPath of [INFO_PLIST_PATH, ASAR_PATH, BUNDLED_APP_SERVER_PATH]) {
      if (!fs.existsSync(requiredPath)) throw new Error(`Missing ChatGPT file: ${requiredPath}`);
    }

    const previousState = readState();
    const app = appIdentity();
    const currentAsarIdentity = fileIdentity(ASAR_PATH);
    const currentBackendIdentity = fileIdentity(BUNDLED_APP_SERVER_PATH);
    if (
      previousState.appBuild === app.build &&
      previousState.asarSize === currentAsarIdentity.size &&
      previousState.asarMtimeMs === currentAsarIdentity.mtimeMs &&
      previousState.backendSize === currentBackendIdentity.size &&
      previousState.backendMtimeMs === currentBackendIdentity.mtimeMs
    ) {
      console.log(`ChatGPT ${app.version} (${app.build}) is already patched.`);
      return;
    }
    const officialBackendChanged =
      previousState.appBuild !== app.build ||
      hashFile(BUNDLED_APP_SERVER_PATH) !== previousState.patchedBackendHash;
    const backendVersion = officialBackendChanged
      ? bundledAppServerVersion()
      : previousState.backendVersion;
    if (backendVersion == null) throw new Error("Cannot determine Desktop app-server version");

    const patchedBackend = ensurePatchedBackend(backendVersion);

    const appAfterBuild = appIdentity();
    if (appAfterBuild.build !== app.build || appAfterBuild.version !== app.version) {
      throw new Error(
        `ChatGPT changed during app-server build (${app.version}/${app.build} -> ${appAfterBuild.version}/${appAfterBuild.build}); retrying on the next maintenance run`,
      );
    }
    const backendVersionAfterBuild = bundledAppServerVersion();
    if (backendVersionAfterBuild !== backendVersion) {
      throw new Error(
        `Bundled app-server changed during build (${backendVersion} -> ${backendVersionAfterBuild}); retrying on the next maintenance run`,
      );
    }

    const frontend = patchFrontend();
    const appBeforeInstall = appIdentity();
    const backendVersionBeforeInstall = bundledAppServerVersion();
    if (
      appBeforeInstall.build !== app.build ||
      appBeforeInstall.version !== app.version ||
      backendVersionBeforeInstall !== backendVersion
    ) {
      throw new Error("ChatGPT changed while applying the frontend patch; refusing backend install");
    }
    const backend = installBackend(patchedBackend, app, previousState);
    const asarIdentity = fileIdentity(ASAR_PATH);
    const backendIdentity = fileIdentity(BUNDLED_APP_SERVER_PATH);
    const nextState = {
      appBuild: app.build,
      appVersion: app.version,
      asarMtimeMs: asarIdentity.mtimeMs,
      asarSize: asarIdentity.size,
      backendMtimeMs: backendIdentity.mtimeMs,
      backendSize: backendIdentity.size,
      backendVersion,
      frontendStatus: frontend.status,
      frontendOffset: frontend.offset ?? previousState.frontendOffset ?? null,
      patchedBackendHash: backend.patchedHash,
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
        `Patched ChatGPT ${app.version} (${app.build}). Restart ChatGPT to load the fixes.`,
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

  const backupPath = path.join(STATE_DIR, "backups", app.build, "codex.original");
  if (fs.existsSync(backupPath)) {
    const temporaryPath = `${BUNDLED_APP_SERVER_PATH}.desktop-fixer-restore-${process.pid}`;
    fs.copyFileSync(backupPath, temporaryPath);
    fs.chmodSync(temporaryPath, 0o755);
    fs.renameSync(temporaryPath, BUNDLED_APP_SERVER_PATH);
  }
  writeState({ ...state, restoredAt: new Date().toISOString() });
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
  const installedProgramDir = path.join(STATE_DIR, "program");
  fs.mkdirSync(installedProgramDir, { recursive: true });
  for (const fileName of ["fixer.mjs", "build-backend.mjs"]) {
    fs.copyFileSync(path.join(SOURCE_DIR, fileName), path.join(installedProgramDir, fileName));
  }
  fs.cpSync(path.join(SOURCE_DIR, "patches"), path.join(installedProgramDir, "patches"), {
    recursive: true,
  });
  for (const localBuildCache of [
    path.join(SOURCE_DIR, "bin"),
    path.join(SOURCE_DIR, ".build", "bin"),
  ]) {
    if (fs.existsSync(localBuildCache)) {
      fs.cpSync(localBuildCache, path.join(STATE_DIR, "bin"), { recursive: true });
    }
  }

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
  run("/bin/launchctl", ["bootstrap", domain, AGENT_PATH]);
  maintain();
  console.log(`Installed ${AGENT_LABEL} at ${AGENT_PATH}`);
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

function status() {
  const archive = fs.readFileSync(ASAR_PATH);
  const state = readState();
  console.log(
    JSON.stringify(
      {
        app: appIdentity(),
        backendHash: hashFile(BUNDLED_APP_SERVER_PATH),
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
  default:
    throw new Error(`Unknown command: ${command}`);
}
