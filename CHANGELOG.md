# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-15

### Changed

- Replaced the default Rust rebuild with a sub-4 KiB app-server launch shim.
- Use the original bundled app-server with command-line provider overrides and an official model
  catalog normalized to standard Responses.
- Read the existing API key from `auth.json` at process launch without copying it into patch state.
- Download only the matching upstream `models.json` after a new Desktop app-server version appears.
- Keep the source-based Rust patch as an explicit legacy developer fallback only.

### Added

- Isolated lightweight install/idempotency/restore integration test.
- Request-level probe confirming Bearer auth, hosted web search, code-mode image generation, and the
  absence of the Responses Lite header on the original `0.144.2` backend.
- Cleanup command for legacy state-directory Rust targets and compiled backend caches.

### Removed

- Automatic Rust toolchain installation, Codex source clone, Cargo build, strip, and code-sign steps
  from the normal installer and LaunchAgent maintenance path.

## [0.1.0] - 2026-07-15

### Added

- Exact-length Desktop frontend patch that preserves in-flight steering follow-ups.
- Runtime-gated hosted web search and image generation for API-key custom providers.
- Source-based patched ChatGPT Desktop app-server builds from matching official Codex tags.
- Version, hash, patch applicability, code-signature, and bundle race checks.
- Per-build app-server backups with restore and uninstall commands.
- LaunchAgent maintenance after ChatGPT updates.
- Reuse of locally compiled `.build/bin/chatgpt-app-server-<version>` artifacts during install.

### Verified

- ChatGPT Desktop `26.707.72221` build `5307`.
- Bundled app-server `0.144.2` on Apple Silicon macOS.
