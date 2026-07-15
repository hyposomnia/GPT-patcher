# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
