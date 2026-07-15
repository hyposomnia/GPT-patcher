# Contributing

Contributions are welcome, especially compatibility updates for new ChatGPT Desktop builds.

## Before opening a pull request

1. Keep changes scoped to the ChatGPT Desktop bundle. Do not install or replace a global Codex CLI.
2. Do not commit compiled app-server binaries, Rust targets, downloaded source trees, logs, or secrets.
3. Preserve the fail-closed behavior for unknown frontend anchors and non-applicable backend patches.
4. Add or update regression-test markers when changing the backend patch.
5. Run:

   ```sh
   npm test
   ```

6. When the matching official Codex source is available, also run:

   ```sh
   CODEX_SOURCE_DIR=/path/to/codex npm test
   ```

## Compatibility updates

Include the ChatGPT Desktop version, build number, bundled app-server version, architecture, and the
exact validation performed. Avoid fuzzy anchor matching or bypassing `git apply --check` to make a new
version appear compatible.

## Commit style

Use short, imperative commit subjects. Keep generated artifacts out of commits.
