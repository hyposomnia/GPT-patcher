# Troubleshooting and Recovery Notes

## macOS App Management and the v0.1.0 patch flow

This note records the July 15, 2026 recovery of ChatGPT Desktop
`26.707.72221` (build `5307`, bundled app-server `0.144.2`) on Apple Silicon.
It applies specifically to the source-rebuild workflow released as `v0.1.0`
(`74dd508`).

### Observed failures

The same `v0.1.0` files could patch the installed application from an
interactive ChatGPT Desktop task, while the following execution paths failed
with `EPERM` when opening `Contents/Resources/app.asar` for writing:

- a command sent from `codex-cli` after quitting the Desktop application;
- a one-shot `launchctl submit` job;
- a LaunchAgent performing the first patch;
- `osascript` with `administrator privileges`, including a root `touch` probe.

Replacing the complete modified application with a local Installer package
was not a valid workaround. PackageKit could write the files, but macOS then
reassessed the modified application bundle and repeatedly displayed the
“ChatGPT is damaged and can’t be opened” dialog.

### Root cause

The installed application was owned by the user and had ordinary writable
Unix permissions, but its root carried `com.apple.macl` and the application
files carried `com.apple.provenance`.

macOS App Management authorization depends on the responsible process, not
only the effective UID. The interactive ChatGPT Desktop tool process was
allowed to modify the application bundle. A CLI shell, background launchd
job, AppleScript shell, and even a root subprocess did not inherit that
authorization.

The important distinction was therefore the execution identity:

- **worked:** direct tool call from a running, interactive ChatGPT Desktop task;
- **failed:** CLI, detached watcher, LaunchAgent-first installation, or
  privileged AppleScript shell.

The patcher source was not the difference. The installed `fixer.mjs` and
`build-backend.mjs` were byte-for-byte identical to tag `v0.1.0` during the
successful and failed attempts.

### Required preflight

Start from a freshly installed official ChatGPT Desktop application. Before
changing the bundle, verify its version, original backend hash, frontend
anchor, and complete signature.

Run a reversible App Management probe from the same interactive Desktop task
that will apply the patch:

```sh
touch /Applications/ChatGPT.app/Contents/Resources/.gpt-patcher-write-test
rm /Applications/ChatGPT.app/Contents/Resources/.gpt-patcher-write-test
codesign --verify --deep --strict --verbose=2 /Applications/ChatGPT.app
```

Do not continue if `touch` returns `Operation not permitted`, if the probe file
cannot be removed, or if the official signature does not verify after removal.
Changing to `sudo`, `osascript`, or a background job does not solve this App
Management denial.

### Proven v0.1.0 installation order

Keep the official Desktop application running and perform the initial patch
from its interactive task. The running app-server continues using its already
opened original executable until the manual restart.

1. Build and validate the patched app-server outside the application bundle.
   Do not install or replace the global `codex-cli`.
2. Confirm the cached original backend matches the official bundled backend.
3. Call `fixer.mjs apply` directly from the interactive Desktop task.
4. Verify state, hashes, and frontend anchors without directly executing the
   modified bundled backend.
5. Only after `apply` succeeds, run the tag's `install.sh` to register the
   maintenance LaunchAgent.
6. Quit ChatGPT manually with `Cmd+Q`, reopen it normally, and verify the new
   main-process and app-server PIDs.

Applying first and installing the LaunchAgent second avoids a startup race in
which the new LaunchAgent could acquire the maintenance lock before the
interactive process and then fail its first write for lack of App Management
authorization.

Expected status after `apply` for this incident:

```text
app version:             26.707.72221
app build:               5307
app-server version:      0.144.2
frontend original:       0
frontend patched:        1
patched backend size:    330366056 bytes
patched backend SHA-256: 174650143b0e33adb477fdbdd99f0d4c2b4d33487208aaad990f708286e67e40
original backend SHA-256: 4a9e84ad1c9622e8f6a50dafd75710eaee4af79dc5bcf8bafd4471763255fe18
```

The patched backend must pass its own `codesign --verify`. Do not use a deep
verification of the outer application bundle as the post-patch success test:
the intended resource changes invalidate the original bundle seal.

### Verification after restart

Treat the restart as successful only when all of the following hold:

- ChatGPT Desktop opens without a Gatekeeper warning;
- both the main process and `codex ... app-server` have new PIDs;
- the bundled backend hash matches the validated build artifact;
- frontend anchors are `original=0` and `patched=1`;
- patcher state records the same backend hash, size, and app build;
- the maintenance LaunchAgent is loaded and its most recent exit code is `0`;
- `maintain.log` contains `already patched` and no new error.

Do not run `/Applications/ChatGPT.app/Contents/Resources/codex --version`
directly after patching. Validate by starting the main application, inspecting
the app-server process, checking the file hash, and verifying the backend's
embedded signature.

### Recovery rules

If the first write returns `EPERM`, stop immediately. Do not retry through a
watcher or package the modified application.

If macOS reports that ChatGPT is damaged:

1. remove any one-shot installer job and unload the patcher LaunchAgent;
2. cancel the Gatekeeper dialog instead of repeatedly relaunching the app;
3. reinstall the official ChatGPT Desktop application;
4. verify the official backend hash and complete application signature;
5. repeat the interactive Desktop preflight before attempting `v0.1.0` again.

Keep the build-specific original backend backup. It provides evidence that a
reinstalled bundle is official and remains useful for recovery, but it cannot
by itself bypass App Management restrictions on `app.asar`.

### Maintainer takeaway

Automatic maintenance can safely report an already-patched build, but a new
or replaced ChatGPT application may require an interactive Desktop-authorized
first patch. Any future installer should explicitly detect this condition and
ask for an interactive repair instead of silently switching execution identity
or attempting a full-bundle replacement.
