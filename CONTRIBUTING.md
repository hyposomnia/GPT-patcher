# Contributing

Contributions are welcome, especially compatibility updates for new ChatGPT Desktop builds.

## Before opening a pull request

1. Keep changes scoped to the ChatGPT Desktop bundle. Do not install or replace a global Codex CLI.
2. Do not commit compiled app-server binaries, Rust targets, downloaded source trees, logs, or secrets.
3. Preserve the fail-closed behavior for unknown frontend anchors, non-managed backends, invalid model
   catalogs, and app/config races.
4. Keep the default install path free of Rust, Cargo, source clones, and compiled backend artifacts.
5. Update the isolated shim test when changing provider overrides, catalog generation, backup, or
   restore behavior.
6. If changing the legacy backend patch, also update its regression-test markers.
7. Run:

   ```sh
   npm test
   ```

8. When the matching official Codex source is available, also run:

   ```sh
   CODEX_SOURCE_DIR=/path/to/codex npm test
   ```

## Compatibility updates

Include the ChatGPT Desktop version, build number, bundled app-server version, architecture, official
model-catalog source, and the exact validation performed. Avoid fuzzy anchor matching or silently
falling back to a catalog from a different app-server version.

## Commit style

Use short, imperative commit subjects. Keep generated artifacts out of commits.
