# Installed UI runtime audit

`audit:installed-ui` performs a read-only health check against the currently installed Sovereign desktop shell. It does not launch, focus, navigate, click, restart, install, activate, roll back, or modify application settings.

## Usage

```powershell
pnpm --filter @sovereign/desktop-tauri audit:installed-ui
```

Release acceptance can bind the expected process and active Renderer:

```powershell
pnpm --filter @sovereign/desktop-tauri audit:installed-ui -- \
  --expect-pid 105632 \
  --expect-release renderer-example-100 \
  --expect-version 0.1.10
```

Use `--strict` when warnings must fail the command. Strict mode currently treats a missing WebView UI Automation tree, a minimized window, multiple shell/browser processes, and retained Renderer failure history as acceptance failures.

```powershell
pnpm --filter @sovereign/desktop-tauri audit:installed-ui -- --strict
```

A screenshot is opt-in because the current window may contain sensitive project information:

```powershell
pnpm --filter @sovereign/desktop-tauri audit:installed-ui -- --capture-screenshot
```

The screenshot is created in a new, uniquely allocated capture directory below `%LOCALAPPDATA%\com.sovereign.runtime\ui-audit`. Existing files are never overwritten. The PowerShell result must return that exact destination; the Node verifier rejects links, hard links, files above the 64 MiB ceiling, parent-path replacement, and any file identity change before or during hashing. Capture uses `PrintWindow`; it does not bring Sovereign to the foreground and does not fall back to copying arbitrary desktop pixels. Blank captures are rejected and not written. A tray-hidden Tauri window may therefore require the operator to reveal it before requesting screenshot evidence. The report includes dimensions, byte length, sampled-color count, and SHA-256.

## Checks

The JSON report covers:

- exact installed executable identity and process count;
- process responsiveness and expected PID;
- main-window visibility, minimized/hung/cloaked state, bounds, and virtual-screen intersection;
- the bounded descendant WebView2 process tree, renderer presence, version, and application-owned user-data root;
- bounded UI Automation availability and recognized navigation labels, without collecting arbitrary accessible text;
- the complete durable Renderer state journal: contiguous revision names, exact persisted schema, cumulative byte limits, raw-byte SHA-256 predecessor chain, active release, rollback release, retained failure, and monotonic release counter;
- the installed trust registry, Ed25519 envelope, ready-marker identity, exact metadata allowlist, manifest entrypoint, and every declared component's byte length and SHA-256, with missing or unmanifested slot content rejected;
- optional expected release/version and opt-in screenshot evidence.

The active Renderer inspection is read-only and accepts only direct, unshared regular files under the expected roots. It rejects missing state revisions, malformed or broken hash chains, pending journal remnants, unknown metadata entries, symbolic links, hard links, reparse escapes, oversized files or journals, invalid release identities, bad signatures, incomplete inventories, and mismatched digests.

A verified state journal whose latest state has `activeRelease: null` and `lastKnownGoodRelease: null` represents the built-in Renderer. That state still requires a valid contiguous journal, revision/hash-chain integrity, a monotonic release counter, and valid failure metadata, but it does not require an external slot, ready marker, signature envelope, manifest inventory, or custom entrypoint. Supplying `--expect-release` or `--expect-version` explicitly requires an external Renderer and therefore fails against the built-in Renderer.

WebView2 composition mode may expose only the native shell window and no navigable UI Automation descendants. The audit reports that limitation explicitly. Default mode records it as a warning; strict mode fails. Visual layout and interactive page behavior remain covered by the isolated Electron visual harness and coordinated release acceptance, not by hidden focus or synthetic clicks against the user's installed window.

The parent PowerShell process retains a hard 30-second timeout and the UI Automation capacity remains 2,500 elements. Accessibility enumeration runs on a background STA worker under a shorter 20-second deadline measured from probe start. Reaching the deadline or element ceiling returns complete bounded JSON with `limited: true`, a fixed `limitStage`, a bounded diagnostic, elapsed milliseconds, and any evidence already collected. Default mode preserves that condition as a warning; strict mode fails on the warning. The audit must return this evidence before the parent timeout rather than terminating with `ETIMEDOUT`.
