# Desktop Visual Testing

## Purpose

Sovereign Code Runtime includes a deterministic offscreen Electron visual test for the production desktop renderer. It is intended to catch layout regressions that ordinary TypeScript and unit tests cannot detect, while keeping the test independent from user credentials, filesystem mutation, and live MCP sessions.

The harness is implemented in:

```text
apps/desktop/src/visual-test.ts
apps/desktop/vite.visual.config.ts
```

It uses the same built renderer, CSS, preload bridge, Chromium engine, sandbox, context isolation, and BrowserWindow security settings as the desktop application. Runtime state, manifest rows, capabilities, and audit receipts are supplied by a local fixture through the typed IPC contract.

## Running the test

From the repository root:

```powershell
pnpm test:visual
```

The normal test command also includes the visual pass:

```powershell
pnpm test
```

The visual harness does not open a visible application window and does not require an MCP client, Bearer credential, or external service.

## Captured surfaces

Every run discovers and captures all thirteen registry-driven desktop pages:

- Runtime
- Agent
- Runs
- Terminal
- Python
- Browser
- Workflows
- Computer
- Workspaces
- Capabilities
- Approvals
- Audit
- Settings

Each page is rendered at two supported content sizes:

```text
1360×860  default application size
1040×680  minimum application size
```

This produces 26 PNG screenshots under:

```text
apps/desktop/visual-artifacts/1360x860/
apps/desktop/visual-artifacts/1040x680/
```

A machine-readable report is written to:

```text
apps/desktop/visual-artifacts/report.json
```

Every screenshot record contains its relative path, exact dimensions, byte length, SHA-256 digest, active page, document dimensions, shell bounds, and layout-audit results.

## Enforced invariants

The run fails when any of the following conditions is detected:

1. More or fewer than one requested page is active.
2. The document creates horizontal overflow beyond the viewport.
3. The application shell does not fill the renderer viewport.
4. A visible element outside an intentional scroll container extends beyond the horizontal viewport.
5. The DOM contains duplicate identifiers.
6. A required shell, navigation, status, or active-page element is absent.
7. Leaf text is clipped by a hidden or clipped overflow rule without an intentional ellipsis treatment.

Animations and transitions are disabled during capture so that PNG output and geometry remain stable.

## Evidence interpretation

A zero-error report confirms that the rendered application satisfies the checked geometry and DOM invariants for the tested states and viewports. PNGs remain available for human review of hierarchy, typography, spacing, contrast, visual balance, and other qualities that are not safely reducible to a single numeric threshold.

The fixture represents a running local Gateway with a selected workspace, forty-eight manifest tools, twenty-one capabilities, representative Web Agent/bridge state, terminal/browser/computer state, run records, and successful, denied, and failed audit receipts. It deliberately contains no production token or user data.

## Scope boundary

The offscreen pass is a renderer-level visual regression test. It does not replace a governed Windows desktop smoke test of the packaged executable. A full physical smoke pass additionally verifies:

- process launch and shutdown;
- native window chrome and focus behavior;
- Windows folder-picker integration;
- installer shortcuts and uninstall behavior;
- host DPI and display scaling;
- GPU-driver-specific rendering;
- live keyboard, mouse, accessibility, and window-management interactions.

Those operations should be exercised through an authorized Not-Computer session or another controlled Windows UI automation environment. They must not bypass capability leases, user approvals, observation revisions, or action receipts.

## Baseline policy

The repository currently records generated screenshots as local ignored artifacts rather than committed pixel baselines. This avoids treating anti-aliasing, GPU, font-rasterization, and Chromium-version differences as source changes. A future baseline system should normalize the execution environment and use perceptual comparison with explicit review, rather than requiring byte-identical PNG output across arbitrary Windows hosts.
