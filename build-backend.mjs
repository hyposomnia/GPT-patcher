#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [version, stateDir, programDir] = process.argv.slice(2);
if (version == null || stateDir == null || programDir == null) {
  throw new Error("Usage: build-backend.mjs <version> <state-dir> <program-dir>");
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`Unsafe app-server version: ${version}`);
}

const sourceDir = path.join(stateDir, "build", `codex-${version}`);
const outputDir = path.join(stateDir, "bin");
const outputPath = path.join(outputDir, `chatgpt-app-server-${version}`);
const patchPath = path.join(programDir, "patches", "desktop-hosted-tools.patch");
const userHome = os.homedir();
const cargoHome = path.join(userHome, ".cargo");
const rustupHome = path.join(userHome, ".rustup");
const buildHome = path.join(stateDir, "build-home");
const cargoPath = path.join(cargoHome, "bin", "cargo");
const rustupPath = path.join(cargoHome, "bin", "rustup");

fs.mkdirSync(buildHome, { recursive: true });

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    env: {
      ...process.env,
      HOME: buildHome,
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: rustupHome,
      CARGO_NET_GIT_FETCH_WITH_CLI: "true",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.version",
      GIT_CONFIG_VALUE_0: "HTTP/1.1",
      PATH: `${path.dirname(cargoPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      ...options.env,
    },
    stdio: options.stdio ?? "inherit",
  });
}

function validateBackend(filePath) {
  const output = run(filePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (output !== `codex-cli ${version}`) {
    throw new Error(`Unexpected app-server version at ${filePath}: ${output}`);
  }
}

function cargoTomlFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === ".git") continue;
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...cargoTomlFiles(entryPath));
    if (entry.isFile() && entry.name === "Cargo.toml") files.push(entryPath);
  }
  return files;
}

function excludeUnrelatedRealtimeWebrtc() {
  const rustDir = path.join(sourceDir, "codex-rs");
  const workspaceManifest = path.join(rustDir, "Cargo.toml");
  const memberLine = '    "realtime-webrtc",\n';
  const manifest = fs.readFileSync(workspaceManifest, "utf8");
  const memberCount = manifest.split(memberLine).length - 1;
  if (memberCount === 0) return;
  if (memberCount !== 1) {
    throw new Error(`Unexpected realtime-webrtc workspace member count: ${memberCount}`);
  }

  const ownManifest = path.join(rustDir, "realtime-webrtc", "Cargo.toml");
  const references = cargoTomlFiles(rustDir).filter((filePath) => {
    if (filePath === workspaceManifest || filePath === ownManifest) return false;
    return fs.readFileSync(filePath, "utf8").includes("realtime-webrtc");
  });
  if (references.length > 0) {
    throw new Error(
      `Refusing to exclude realtime-webrtc because it is referenced by: ${references.join(", ")}`,
    );
  }

  fs.writeFileSync(workspaceManifest, manifest.replace(memberLine, ""));
  console.log(
    "Excluded the independent realtime-webrtc workspace member from this app-server build.",
  );
}

if (!fs.existsSync(path.join(sourceDir, ".git"))) {
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
  run("/usr/bin/git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    `rust-v${version}`,
    "https://github.com/openai/codex.git",
    sourceDir,
  ]);
}

const markerPath = path.join(sourceDir, ".chatgpt-desktop-fixer-patched");
if (!fs.existsSync(markerPath)) {
  let patchNeeded = false;
  try {
    run("/usr/bin/git", ["apply", "--check", patchPath], {
      cwd: sourceDir,
      stdio: "ignore",
    });
    patchNeeded = true;
  } catch {
    try {
      run("/usr/bin/git", ["apply", "--reverse", "--check", patchPath], {
        cwd: sourceDir,
        stdio: "ignore",
      });
      console.log("Recovered an already-patched source tree with a missing marker.");
    } catch {
      run("/usr/bin/git", ["apply", "--check", patchPath], { cwd: sourceDir });
    }
  }
  if (patchNeeded) run("/usr/bin/git", ["apply", patchPath], { cwd: sourceDir });
  fs.writeFileSync(markerPath, `${version}\n`);
}

// ChatGPT Desktop ships its app-server inside the upstream `codex-cli` package's `codex` binary.
// This build is cached only for the Desktop app and is never installed as a global Codex CLI.
// Cargo resolves every workspace member before a package-only build. The standalone WebRTC crate
// is not used by the Desktop app-server, but its libyuv submodule may be unavailable on restricted
// networks.
excludeUnrelatedRealtimeWebrtc();

const toolchainFile = path.join(sourceDir, "codex-rs", "rust-toolchain.toml");
const toolchainText = fs.readFileSync(toolchainFile, "utf8");
const toolchain = toolchainText.match(/^channel\s*=\s*"([^"]+)"/mu)?.[1];
if (toolchain == null) throw new Error(`Cannot read Rust toolchain from ${toolchainFile}`);
if (!fs.existsSync(rustupPath)) {
  throw new Error("rustup is required for automatic ChatGPT app-server rebuilds");
}
run(rustupPath, [
  "toolchain",
  "install",
  toolchain,
  "--profile",
  "minimal",
  "--component",
  "clippy",
  "--component",
  "rustfmt",
  "--component",
  "rust-src",
]);

run(cargoPath, ["build", "--release", "-p", "codex-cli", "--bin", "codex"], {
  cwd: path.join(sourceDir, "codex-rs"),
});

const builtPath = path.join(sourceDir, "codex-rs", "target", "release", "codex");
if (!fs.existsSync(builtPath)) throw new Error(`Cargo did not create ${builtPath}`);
validateBackend(builtPath);
fs.mkdirSync(outputDir, { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
try {
  fs.copyFileSync(builtPath, temporaryPath);
  fs.chmodSync(temporaryPath, 0o755);
  run("/usr/bin/strip", ["-S", temporaryPath]);
  try {
    run("/usr/bin/codesign", ["--verify", "--verbose=2", temporaryPath]);
  } catch {
    run("/usr/bin/codesign", ["--force", "--sign", "-", temporaryPath]);
  }
  validateBackend(temporaryPath);
  fs.renameSync(temporaryPath, outputPath);
} finally {
  fs.rmSync(temporaryPath, { force: true });
}
console.log(`Built patched ChatGPT Desktop app-server: ${outputPath}`);
