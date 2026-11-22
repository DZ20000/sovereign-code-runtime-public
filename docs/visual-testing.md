# Desktop visual testing

The isolated Electron harness exercises the production desktop renderer, CSS and preload against synthetic IPC responses. It checks layout and interaction without launching a Gateway, RuntimeHost, external tunnel, Gemini listener, terminal process or real approval. It does not read a saved connection, user credential or production profile.

Browser and desktop preview media are drawn on an unattached canvas inside that isolated renderer and marked as synthetic fixtures. The harness checks that the production image elements decode them; it never captures the operator's desktop or opens the depicted site.

## Running the checks

From the repository root, run the static script and isolation checks first:

```powershell
pnpm exec vitest run apps/desktop/test/visual-script-syntax.test.ts apps/desktop/test/visual-matrix.test.ts apps/desktop/test/visual-workspace.test.ts
```

After the renderer changes are complete, run the built renderer:

```powershell
pnpm test:visual
```

`pnpm test` also includes this visual pass. `verify:push` and the source-check workflow do not imply that the screenshot matrix ran; record the separate visual result when reviewing UI changes.

To exercise only Task interactions and the four Task surfaces across the same eight contexts:

```powershell
$env:SCR_VISUAL_SCOPE = 'tasks'
pnpm test:visual
Remove-Item Env:SCR_VISUAL_SCOPE
```

For a focused interaction rerun while refining behavior, use `SCR_VISUAL_SCOPE=checks`; it skips the main matrix and popup captures and records `verificationStatus: "checks-only"`. This does not replace the final complete visual run.

For a change limited to the developer tools, `SCR_VISUAL_SCOPE=workbench` runs only the native editor, output-tab, workflow, browser and computer interaction checks. It also records `checks-only`; the other passing checks can be reused while iterating, then verified with the final complete matrix.

The launcher opens no visible window. It creates a fresh profile and evidence directory for every invocation. Running the harness does not restart or adopt an existing application.

## Actual CSS viewport matrix

The main matrix is the Cartesian product of:

| Dimension | Values |
| --- | --- |
| Language | `en`, `zh-CN` |
| Theme | `light`, `dark` |
| CSS viewport | `1040 × 680`, `1360 × 860` |
| Electron zoom | exactly `1` |

Before each capture the harness verifies `window.innerWidth`, `window.innerHeight`, the document language and applied theme, and the Electron zoom factor. Routine success confirmations are dismissed through their real close control; error alerts are retained. A zoomed 1040-pixel window is not accepted as a 1040-pixel CSS viewport.

Each of the eight contexts captures twenty-one surfaces:

- Full Home and single-page Simple Home.
- ChatGPT and Gemini configuration drawers.
- Gemini protected-values, import-preview and preset dialogs.
- Task conversation, steps, associated output and all-run history.
- Pending approvals and the audit center with an opened receipt.
- General and appearance, Workspace and permissions, and Advanced and diagnostics settings.
- Terminal, Python, Browser, Computer after capturing the synthetic desktop, and Workflows.

The four primary navigation entries are Home and connections, Tasks, Approvals and audit, and Settings. Developer tools start collapsed. Simple mode hides the sidebar and developer tools and keeps its default Home within one page. Agent and Runs are no longer independently mounted pages.

The main matrix produces 168 PNGs. The Tasks-only scope produces 32 PNGs. Separate stress captures check Chinese text at 130% font size and 100%/150% application zoom; these are explicitly recorded as scaling probes, not substituted for the matrix's required CSS viewports.

## Approval windows and interaction checks

The approval popup uses the production approval renderer and its own isolated BrowserWindow. It covers both languages and themes at `560 × 480` and `480 × 340`, plus a Chinese dark-theme small-window stress case at 130% font size and 150% CSS interface scale. The ten scenarios per context produce 90 popup captures:

- Normal, destructive and administrator-handoff requests.
- Request flooding, expiration and unavailable request state.
- A failed acknowledgement for each risk class.
- A pending acknowledgement with controls disabled.

Only a fixture explicitly marked as requiring an administrator is shown as handoff. Its action sends `deny` and returns control to the operator. The harness verifies exactly one resolution attempt, no retry after an uncertain acknowledgement, no decision when opening a queued request, and recovery back to the approval center. Every IPC action remains inside the fixture.

Other functional probes retain important behavior while following the v2 information architecture:

- Task selection, five queue semantics, inferred activity, history pagination, stale-response protection, refresh stability and coordination information.
- Per-task drafts, literal message preservation through localization, IME confirmation, native keyboard submission and no duplicate send.
- Navigation and Task-list pointer/keyboard resizing and saved widths.
- One permissions editor, explicit Apply, L4 state across reload and Full/Simple mode, and project-directory changes that do not alter the base workspace permission.
- Interface previews that are saved only on explicit Save, system theme changes, native select keyboard interaction and reduced motion.
- Gemini import preview, presets, protected-value modal Cancel/Escape, staged Apply, exact keep/replace/forget payloads, failed-save draft retention, save without starting, explicit listener start/stop, and fixed error text. Protected drafts never enter localStorage.
- ChatGPT protected fields remain empty when a stored value exists. Tunnel readiness, Gemini listener readiness and the aggregate MCP session count are checked as different facts.
- Real CodeMirror editing, code-preserving localization, workflow undo/focus, terminal scroll following and selected browser/computer state. Python output tabs retain the draft and selection across refresh without another run. Browser view tabs retain the same observation and do not trigger another browser operation.

## Output ownership and evidence

The launcher always allocates a unique directory under the current repository:

```text
.sovereign/scratch/v2-visual-<unique suffix>/
```

It does not honor an inherited output or profile destination. Before Electron uses a profile, the harness validates that the evidence directory is a direct child of this repository's scratch directory, that its run marker matches, and that its `user-data` directory has no symlink or junction escape. It removes only that run's profile after the Electron child exits. Screenshots and reports are retained; another run's files and arbitrary supplied paths are never cleanup targets.

The launcher prints the exact evidence path. Main captures are organized as:

```text
en/light/1040x680/home-full.png
zh-CN/dark/1360x860/connection-gemini.png
approval/en/light/560x480-font-1-ui-1/normal-pending.png
```

`report.json` uses `scr.visual-test/v2`. It is first written with `verificationStatus: "matrix-only"` after capture and changes to `"complete"` only after the interaction checks finish. A matrix-only report is not a complete pass. It records each main capture's language, theme, mode, actual viewport, zoom, file dimensions, SHA-256, active view and layout audit. `approval-states.json` records the popup scenarios and observed decision counts. Additional JSON files document the Task, project-workspace, shared-control, Home and developer-tool checks. A failure also retains its screenshot, DOM snapshot and error in the same owned directory; all input values in these files come from fixtures.

The layout pass fails on incorrect active views, horizontal overflow, shell-width mismatch, duplicate DOM identifiers or missing required controls. Edge crowding, ambiguous affordances, tight gutters and possible clipped text remain review findings in the report. Human screenshot review is required to assess hierarchy, typography and visual consistency; a zero-error geometry report alone is not design approval.

## Scope of this evidence

This is a Chromium renderer check using the production DOM and bridge, with sandboxing and context isolation enabled. It does not demonstrate real OAuth, DPAPI, external tunnel health, native Windows folder pickers, live approvals, Tauri WebView2 rendering, installer behavior or real display DPI. Those behaviors need their existing unit, transport, native or isolated packaged-smoke checks. Do not label a build released merely because the visual harness passed.
