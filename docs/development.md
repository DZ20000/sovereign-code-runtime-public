# Development and release validation

Use this guide when changing, building, or deploying Sovereign. For an existing build, start with [releases](../releases/README.md). Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for repository and release coordination. Commands below are alternatives for the relevant task, not a checklist to run in sequence.

## Source acquisition and non-launch verification

Use a Git clone of the source repository you have independently verified, with a checked-out commit, for Runtime Host bundles and release packages. Run commands at that repository root. Record `git rev-parse HEAD` and `git status --short` with validation evidence. A registered Git worktree is also supported. Do not initialize a synthetic commit in an unpacked archive merely to claim release provenance.

A source ZIP without `.git` can be read and type-checked, but it is **not** the supported Runtime Host bundling or desktop packaging route. The source-metadata guard rejects missing Git metadata and refuses to use an enclosing repository's commit. Obtain the matching verified clone for those operations. This limitation is explicit; a ZIP build error is not evidence that a clean Git clone fails.

For source checks that do not start or install the SO application:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:products
pnpm test:launchers
pnpm exec vitest run --reporter=dot
pnpm --filter @sovereign/desktop-tauri run prepare:runtime
pnpm --filter @sovereign/desktop-tauri run build:web
pnpm audit --prod
pnpm audit
```

The preparation step compiles native helper resources and bundles the Runtime Host inside this checkout; it does not install them or activate a running SO instance. Source tests can start their own temporary subprocesses and loopback listeners. Skipped native tests are not passing native acceptance. The [Windows workflow](../.github/workflows/source-check.yml) uses Node 24.13.0 and pnpm 10.15.1 on a hosted runner with read-only repository permissions, no retained checkout credential, no publishing, and a separate full-audit gate that fails on unresolved advisories. Defining the workflow is not evidence that a hosted run has executed. Review [dependency security](dependency-security.md) before interpreting its result.

## Source development

Windows prerequisites are WebView2/Edge, Node.js 24+, pnpm 10+, a Rust MSVC toolchain, and the .NET Framework C# compiler used by the native helper. The preferred ChatGPT connection additionally needs the official `tunnel-client`; Python 3 is needed only for Python tools. The package manager version is declared in [package.json](../package.json).

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm dev:desktop
```

`dev:desktop` invokes Tauri development mode. Its configured preparation builds the Runtime Host/native resources and starts Vite; it is not a purely static preview. Optionally set `SCR_WORKSPACE_ROOT` to the intended authorized workspace before launch. The desktop still owns permission selection and local authorization.

The shared UI lives in `apps/desktop/src/renderer`; Tauri imports it from `apps/desktop-tauri/src/main.ts`. Electron-specific host code remains in `apps/desktop`. Android has its own Gradle toolchain and [build/device guide](../apps/android-agent/README.md).

## Choose validation by changed behavior

Start with the smallest check that exercises the changed contract. Broaden when a failure, cross-layer change, or release requirement warrants it. A passed check can be reused while its source and inputs remain unchanged.

| Work being validated | Useful entry point | Effects and limits |
| --- | --- | --- |
| Documentation | Inspect diff, paths, links, and referenced command/source contracts. | No application build or restart is needed for prose-only changes. |
| Product locator | `pnpm test:products` | Uses temporary package fixtures; no build, installation, or product launch. |
| Launch and restart scripts | `pnpm test:launchers` | Verifies target selection, package binding and process isolation with temporary packages and test processes; does not restart the installed SO. |
| TypeScript contract changes | `pnpm typecheck` plus the affected existing Vitest test files. | Typecheck includes runtime and renderer/test typing; it emits runtime build output. Root Vitest tests may import that output, so keep it current. |
| Shared renderer behavior | Affected renderer tests; `pnpm test:visual` when visual behavior changes. | See [visual testing](visual-testing.md); screenshot output alone is not installed-UI evidence. |
| Task panel behavior | `pnpm test:task-panel:focused` | Runs the focused task-panel gate defined by the script; use broader coverage if other contracts changed. |
| Rust/Tauri code | `pnpm check:tauri` for checks; package `test:rust` for Rust tests. | Both prepare runtime resources. Rust tests do not replace rendered-UI or packaged behavior checks. |
| Broad source regression | `pnpm test` | Aggregate source tests and smoke coverage; see its included stages below. |
| New portable candidate | `pnpm build` | Cleans generated build output, creates a portable package, and runs packaged lifecycle smoke. It launches test processes. |
| Existing portable candidate | `verify:portable` for static verification; `pnpm test:tauri` when full Tauri/package revalidation is needed. | The latter prepares/checks source and launches the latest portable candidate; verify that it is the candidate you intend to assess. |
| NSIS installer change or deployment | The installer section below. | Dry-run, real installation, and installed-state verification provide different evidence. |

The package-level command examples above use `pnpm --filter @sovereign/desktop-tauri run <script>`. For a focused Vitest run, use `pnpm exec vitest run <affected-test-file>` after ensuring required runtime output is current. Consult [package.json](../package.json) and [desktop-tauri/package.json](../apps/desktop-tauri/package.json) for exact current composition.

Aggregate coverage currently overlaps:

- `pnpm test`: product-locator and launcher checks, runtime build, Vitest, Electron offscreen visual tests, Runtime Host smoke, Tauri Rust tests, and unbundled Guardian smoke.
- `pnpm check:tauri`: renderer typecheck, runtime preparation, and `cargo check`.
- `pnpm test:tauri`: `check:tauri`, Rust tests, restart-launcher dry-run, portable smoke, and packaged Guardian smoke.
- `pnpm build`: generated-output clean, portable build, then the same restart-launcher, portable, and packaged Guardian smoke stages.

Do not append `test:tauri` mechanically after `build` or repeat `check:tauri` immediately before it. Select uncovered source checks separately when needed. `pnpm test` does not establish NSIS installation coverage. Optional `pnpm benchmark:desktop` compares matched Electron/Tauri resource use; it is not a routine correctness gate.

## Portable package

For a new candidate use `pnpm build`; afterward `pnpm start` launches the newest recorded self-contained portable package. Output is under `apps/desktop-tauri/artifacts/portable-*/`. The package includes:

```text
SovereignCodeRuntime.exe
node/node.exe
host-guardian.mjs
runtime-host.cjs
runtime-manifest.json
native/bin/SovereignNativeAgent.exe
portable-package.json
```

`portable-package.json` (`scr.portable-package/v2`) records Git commit, branch/detached state, commit time, dirty state, product version, and component SHA-256/lengths. `artifacts/latest-portable.json` binds the selected package to its manifest digest. The legacy text pointer exists for launcher compatibility. A pointer or timestamp alone does not prove package integrity.

```powershell
pnpm --filter @sovereign/desktop-tauri run verify:portable
```

This verifies containment, exact component hashes, executable metadata, and aggregate size without launching the package. Portable smoke verifies the package before execution, then requires the real renderer to mount and report its local asset URL, expected title, and non-empty workbench. It also checks Gateway/manifest readiness, bundled Runtime Host, diagnostics, availability storage, and clean shutdown. Packaged Guardian smoke intentionally kills its test Runtime Host and requires a fresh shell, Runtime Host, and running Gateway. These are isolated test-process checks, not evidence that the user's installed application was updated.

## Restart and shortcuts

`pnpm restart` keeps the currently running executable in the current Windows session. If no shell is running, it uses the installed application. Multiple running shells or ambiguous installed locations require an explicit choice; the command does not silently select another build. It asks the selected shell for intentional shutdown and limits any bounded stop fallback to that instance's identified process tree. `pnpm restart:dry-run` shows the target without stopping or launching an application.

To deliberately switch to this checkout's recorded portable build, use `pnpm restart:portable` (or `pnpm restart:portable:dry-run` to inspect it). This is a version switch and can downgrade the application even when both packages say `0.1.0`; compare their source commits. The portable executable must be one of the verified package components before it can be launched.

`pnpm install:restart-shortcut` installs searchable Desktop and Start Menu shortcuts for the ordinary restart that keeps the current version. The repository-root `restart-sovereign.cmd` provides the same action. A portable folder registered for login startup must remain at its registered path. An NSIS-installed application is independent of development `artifacts/portable-*` directories.

These commands stop running work; they do not provide task checkpoint/resume or transactional rollback. The [application restart transaction library](application-restart-updates.md) is not connected to the desktop restart command. A process remaining alive after launch is not proof of Tunnel or remote-session readiness.

A full restart, Renderer activation, and Runtime Host cutover are different transactions. Use [application restart](application-restart-updates.md), [renderer hot updates](renderer-hot-updates.md), or [Runtime Host candidate updates](runtime-candidate-updates.md) for the component being changed. Coordinate running-task disruption and preserve the required release evidence; do not restart the user's application merely to validate documentation or a package file.

## NSIS build and installation

Create an immutable installer candidate from clean committed source:

```powershell
pnpm make:windows
```

The installer entry point owns a per-worktree build lock, removes previous NSIS output before invoking Tauri, and rejects dirty source. This prevents concurrent builds from mixing an old installer with a newer mutable executable. Output is under `apps/desktop-tauri/src-tauri/target/release/bundle/nsis/`, accompanied by `installer-package.json`.

Packaging needs 7-Zip (`SCR_7Z_PATH` can select it). The manifest hashes the executable extracted from the completed installer, which is the authority for installed verification. A later `target/release/sovereign-desktop-tauri.exe` is not equivalent evidence; Windows PE output is not byte-reproducible even from the same source commit.

For an authorized installation, inspect the candidate first and then run the guarded cutover:

```powershell
pnpm --filter @sovereign/desktop-tauri run install:nsis:dry-run
pnpm --filter @sovereign/desktop-tauri run install:nsis
```

The cutover:

1. Verifies the immutable candidate, stages it privately, and rechecks staged bytes before shutdown.
2. Identifies the installed Shell by executable path, Windows session, and process creation time, then waits for its graceful-exit helper and selected process tree. The bounded fallback stops only those verified processes. Unrelated Runtime Hosts stay running; conflicting Shell instances cause refusal before NSIS, whose own name-based stop could otherwise affect them. A control invocation that becomes the primary instance exits without starting another host.
3. After Runtime Host stops, captures verified backups of settings and all task/audit/run SQLite file sets, including WAL, SHM, and rollback-journal sidecars.
4. Re-verifies staged bytes, installs silently, verifies installed executable/runtime hashes against the candidate, checks preserved data, restores login startup, and launches the installed build.
5. Restores unexpected data mutations from verified backup. Recovery launches only a manifest-verified installed executable or a hash-verified previous shell at another path; it never launches an overwritten unverified executable.

## Installation acceptance

A dry-run is **not installation coverage**. The governed installer smoke performs two real current-user cutovers: install/upgrade, then same-version reinstall. It replaces the installed application and requires authorization for that effect; do not run it as a routine source test.

Choose the required operation:

| Command (desktop-tauri package script) | Evidence |
| --- | --- |
| `smoke:installer-install:dry-run` | Inspect the planned two-pass smoke without installation. |
| `smoke:installer-install` | Execute both real cutovers with preserved-data and installed-state checks. |
| `verify:installed` | Verify the installed package and require its exact executable path to be running. |

Each real smoke pass checks settings/SQLite preservation, executable and runtime hashes, Desktop/Start Menu shortcuts, uninstall registration, login-startup target, launch, and continued execution of the exact installed path. Neither renderer smoke nor portable smoke proves these results. Keep candidate provenance, installation receipts, and observed running revision distinct in the final report. [Installed UI audit](installed-ui-audit.md) covers rendered evidence after the relevant readiness boundary.

## Optional headless Gateway

After building runtime output, a local headless Gateway can be started with an authorized workspace and a securely supplied, high-entropy `SCR_BEARER_TOKEN` in the process environment:

```powershell
pnpm start:gateway
```

The `.env.example` file is reference documentation, not an automatically loaded dotenv file. Its Bearer value is deliberately blank; the former long `replace-with-...` value is rejected. Generate a new 32-byte secret directly into this PowerShell process environment without printing or saving its value:

```powershell
$env:SCR_BEARER_TOKEN = node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))"
if ($LASTEXITCODE -ne 0) { throw 'Token generation failed.' }
$env:SCR_WORKSPACE_ROOT = 'C:\Projects\my-authorized-workspace'
try { pnpm start:gateway } finally { Remove-Item Env:SCR_BEARER_TOKEN -ErrorAction SilentlyContinue }
```

Do not put the generated value in command arguments, committed files, logs, screenshots, or chat. Configuration checks reject empty, whitespace, oversized, and recognizable example values, but do not measure randomness. Runtime callers and direct Gateway application callers receive the same guard. Set `SCR_WORKSPACE_ROOT` to the intended folder before launch. Keep the token out of command lines, checked-in files, reports, and logs. The desktop remains the primary product because it provides native workspace/permission selection, approvals, protected-secret lifecycle, and execution inspection. Headless execution does not reproduce that desktop UX.
