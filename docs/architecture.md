# Architecture

## Objective

Sovereign Code Runtime is a local Windows execution runtime that lets **ChatGPT Web act as the agent through MCP**. The model, conversation history, and reasoning remain in ChatGPT; Sovereign owns local authority, workspace containment, execution, approvals, run state, and audit evidence.

The product deliberately avoids a built-in model client. A different MCP host may still connect, but the primary product path is ChatGPT Web.

## Request path

```text
Human operator
  <-> ChatGPT Web conversation
        -> OpenAI Secure MCP Tunnel (preferred outbound connection)
          -> 127.0.0.1 Sovereign Streamable HTTP Gateway
            -> authenticated MCP principal
              -> external permission profile
                -> Tool Catalog / schema validation
                  -> capability + workspace policy
                    -> Windows Adapter primitive
                      -> run state / audit receipt
```

Secure MCP Tunnel is connectivity infrastructure, not a second authority layer inside Sovereign. The Gateway itself remains loopback-only. Sovereign supervises the official `tunnel-client` as a child process, injects the current Gateway Bearer through an environment-referenced static MCP header, observes its local `/readyz` health endpoint, and coordinates bounded connector recovery when Remote Host Mode requests continuous availability. The non-secret tunnel ID and the operator-selected connector path may be persisted. The tunnel runtime API key and optional primary/backup OpenAI control-plane proxies are stored only as Windows-account-protected ciphertext when protection is available and are decrypted into trusted-process memory for tunnel use; plaintext is never written to settings. Proxy selection is never applied to the local loopback MCP target. Classified multi-route execution is an advanced opt-in: only explicit high-confidence control-plane transport failures may progress from same-route retry to backup or an explicitly enabled direct fallback; other failure classes stop for local attention. A user-supplied remote HTTPS `/mcp` reverse bridge remains a separate optional fallback.

## Desktop control plane

`packages/control-plane` owns the shell-independent runtime control plane. `apps/desktop-tauri` is the primary trusted Windows shell: a Tauri 2 / WebView2 front end with a Rust host. Both shells use the shared workbench in `apps/desktop/src/renderer`; the Tauri entry point imports it directly. The Electron-specific host in `apps/desktop` remains available for regression coverage and rollback, and that package also contains the Windows native helper. Shared renderer changes therefore affect the primary application, not only the legacy shell.

The renderer remains unprivileged. The Tauri workbench has no Node.js or raw filesystem access, uses a restrictive Content Security Policy, and can invoke only the command permissions granted to the `main` window capability. The dedicated `approval` window receives a separate capability containing only `approval_current` and `approval_resolve`; it cannot call workbench control methods. Gateway credentials, SQLite handles, process creation, DPAPI, and local filesystem authority stay behind the Rust host / Runtime Host boundary.

A narrow typed renderer bridge exposes runtime lifecycle, workspace selection, manifest/audit/run views, direct local tool surfaces, connection-bundle copy, credential rotation, Gateway/Tunnel automation, current-user Windows login startup, permission-profile selection, UI scale, diagnostics, and ChatGPT Web connection settings.

The shell-independent control plane owns:

- local settings and their validation;
- the transient high-entropy Gateway credential;
- the Gateway lifecycle inside the Node Runtime Host sidecar;
- L1/L2/L3/L4 profile state and direct-tool authorization policy;
- the external L3 `ApprovalBroker`;
- Secure MCP Tunnel supervision, trust state, structured failure diagnostics, and classified control-plane route coordination;
- run, manifest, audit, task/Agent, and owned-process views used by first-party shells.

`apps/runtime-host` runs the single `ControlPlaneController` in a separate Node process. Desktop shell adapters and the Runtime Host communicate over a private versioned JSONL protocol on child stdio; the primary Tauri host launches the packaged portable Node sidecar directly. Every message carries a fresh 256-bit session secret, messages are bounded to 1 MiB, unknown methods fail closed, state events are monotonically sequenced, approval cancellation crosses the protocol explicitly, and loss of the parent/stdio channel shuts the Runtime Host down.

The primary Tauri adapter implements the shell ports for native workspace/connector selection, Windows DPAPI secret protection/restoration, local confirmation dialogs, and the dedicated minimal-permission Approval Window. The Rust host also owns WebView window wiring, per-window command ACLs, notification-area lifecycle, Runtime Host health checks, real Windows process-memory diagnostics, and clipboard TTL cleanup for copied connection bundles. A packaged external Host Guardian watches the Tauri shell from a separate Node process and can restart the entire shell/runtime tree without becoming part of the authority plane. The legacy Electron adapter still maps the shared control ports with `safeStorage` and remains available only as a rollback/reference shell. Neither desktop shell nor the Guardian owns the Gateway, Tunnel supervisor, settings controller, or runtime permission state; those remain in the Runtime Host / shared control plane.

The selected profile is persisted together with the exact normalized authorized workspace root. L1/L2/L3 are stored directly. An explicitly confirmed L4 selection stores a current-user Windows-DPAPI-protected grant containing only its schema version, exact workspace binding, and L4 profile marker; the previous L1-L3 profile remains the fallback. A fresh launch restores the selected profile only when the permission binding matches the current workspace and, for L4, the protected grant decrypts and validates. A stale, corrupt, unreadable, or mismatched grant fails back to the remembered L1-L3 profile, while a workspace-binding mismatch fails closed to L1 and clears the old workspace-restore binding. A trusted local workspace change may rebind the selected profile after local action while clearing that restore binding. Workspace restore is persisted separately and never promotes, demotes, or replaces the selected L1-L4 permission. L3 single-use approvals and direct-tool session approvals are never persisted.

## Agent completion notifications

`system.notify` is a bounded L2 system facade over the packaged `SovereignNativeAgent.exe` helper. The Gateway applies Bearer authentication, capability policy, the active permission profile, schema validation, and normal tool auditing before the Windows adapter launches the helper. The current work owner uses this explicit facade only when a project or Task reaches a meaningful node, needs operator attention, or completes. The helper creates one temporary notification-area icon, confirms acceptance, remains alive for the bounded display duration, and exits.

The notification surface deliberately has no URL, click action, reply, process launch, or arbitrary payload channel. The adapter normalizes text and submits each authorized semantic request directly; it does not infer milestone classes, hash notification content for equivalence, or divide notifications into rolling rate domains. Exact managed-run completion callbacks remain idempotent by run ID. Automatic notices are limited to successful explicit workflows and failed, timed-out, or cancelled runs; routine successful validation, PowerShell, and Python runs and runtime-interrupted runs remain silent. Audit receipts store only title/message digests and lengths, but those digests are privacy evidence rather than deduplication state. Acceptance is not proof of human visibility because Windows Focus Assist and notification policy remain outside Sovereign's authority.

Automatic managed-run notifications default on. Set `SCR_RUN_COMPLETION_NOTIFICATIONS=0` before desktop or headless Gateway launch to disable them; `false`, `off`, and `no` are also accepted. Terminal transitions still write `runs.complete` / `complete_managed_run` receipts, and notification failure never changes the run's terminal state or exit code. Semantic notifications accept only title, message, severity, and display duration: control characters are normalized, titles are bounded to 64 characters and messages to 512. Receipts retain digests, lengths, severity, timing, and mechanism instead of private text. `accepted: true` means Windows accepted the request, not that the operator saw it.

## Activity lifecycle

The Runtime Host publishes bounded external-tool lifecycle events through the shared control-plane state. `ToolCatalog` creates an opaque activity ID after input validation and permission authorization, emits `started` before execution, and emits one terminal `completed` event with success/failure metadata. The lifecycle hook is non-authoritative and fail-open with respect to tool execution: telemetry errors are swallowed and cannot replace a tool result. Raw input, command text, typed text, file content, and output are deliberately excluded.

`ControlPlaneController` retains at most 128 active external operations, emits a desktop state change on start/completion, and clears the set when the Runtime Host stops. Managed background runs continue to use `scr.run/v1` records. The renderer merges those runs with the active lifecycle set and immutable audit receipts, filters passive polling and duplicate run receipts, and refreshes active work at up to one-second intervals. Completed direct calls become durable through their audit receipts; browser and desktop-control surfaces mark local observations stale after new external receipts and resynchronize on visibility.

## Task and Agent registry

`packages/control-plane` owns a local SQLite task registry alongside the existing run and audit stores. It persists project identity, bounded task summaries, Agent identity and heartbeat, step plans, progress, message acknowledgement cursors and the newest 500 task messages. Agent-created project roots are constrained to the exact authorized workspace or a descendant path. Idempotency keys are scoped to the authenticated Agent principal, and mutation calls reject a different owning principal.

The Gateway adds task and coordination tools to the same manifest and policy pipeline as built-in tools. Their live definitions are composed by `createTaskGatewayToolDefinitions`; use the manifest for the current catalog rather than a separate tool count. Task reads are L1; task creation, updates, heartbeats and Agent messages are L2. The Runtime Host protocol also exposes a narrow first-party desktop surface for project snapshots, task detail and local user messages. No renderer receives a SQLite handle.

External tool lifecycle events attach to the most recent active explicit task for the same project and principal. When none exists, Sovereign creates one inferred task and completes it when the associated activity count reaches zero. Task-management and polling tools are excluded from inference to prevent recursive tasks and activity noise. Runtime shutdown marks active Agent tasks blocked and appends a local system message so stale work never remains indefinitely green. The detailed model is documented in `docs/task-agent-hub.md`.

## Four permission profiles

Tools declare immutable risk metadata through:

```text
permissionLevel: observe | workspace | consequential
approvalMode: none | session | single-use
```

The externally connected ChatGPT principal is then constrained by one runtime profile:

```text
L1 Observe        -> observe tools only
L2 Workspace      -> observe + workspace tools
L3 Consequential  -> L1/L2 direct; each consequential tool needs one dedicated local approval
L4 Bypass         -> all declared tool levels; no Sovereign L2/L3 prompt
```

L4 does not bypass tool schemas, capability checks, workspace containment, SHA-256 guards, revision checks, browser credential handoffs, run bookkeeping, or audit receipts. It also does not grant Windows administrator elevation. Its only purpose is to let a locally trusted ChatGPT Web agent operate at the current Windows user's authority without repetitive Sovereign approval prompts.

The renderer cannot enable L4 silently. Setting the profile to `bypass` always passes through the trusted main process and a native warning dialog. The model never supplies or modifies its own permission metadata.

## Runtime Host and Gateway

`apps/runtime-host` is the desktop-owned Node sidecar. It hosts `packages/control-plane`, which in turn starts `apps/gateway/src/runtime.ts`. The Gateway implementation still supports the optional headless entry point, but it is no longer embedded in any desktop-shell process.

Desktop mode binds to `127.0.0.1` on an ephemeral port with a fresh credential generated and retained inside the Runtime Host process. The Gateway exposes:

- `POST /mcp` for MCP initialization and JSON-RPC requests;
- `GET /mcp` for an existing Streamable HTTP session;
- `DELETE /mcp` for session termination;
- `GET /v1/manifest` for the authenticated versioned tool catalog;
- `GET /healthz` for bounded local health state.

Host, optional Origin, and Bearer authentication are checked before the MCP transport. Each MCP session is principal-bound. Session capacity is bounded at 128 by default. Capacity pressure first reclaims the oldest session that has been idle for at least five minutes and has no in-flight request; ordinary idle expiry is 30 minutes. A 429 is returned only when capacity is exhausted and no safe idle candidate can be reclaimed.

The Gateway has two catalogs over the same definitions:

```text
external catalog
  -> ChatGPT Web / external MCP clients
  -> active RuntimePermissionProfile gate
  -> bounded L3 ApprovalBroker + dedicated Approval Window

internal catalog
  -> trusted first-party desktop surfaces
  -> direct main-process approval broker
```

This separation means the renderer cannot escape approval by calling an internal HTTP route, while the local desktop UI can still reuse the same schemas, capabilities, and Windows primitives without pretending to be an external MCP client.

## Host Guardian and desktop lifecycle

Normal packaged Tauri builds include `host-guardian.mjs` beside the Runtime Host bundle and run it with the packaged portable Node executable. The Guardian is intentionally smaller than the Runtime Host: it receives only the current shell PID, exact shell executable path, bounded restart arguments, state-file paths, and a fresh per-launch 256-bit token. It receives no Gateway Bearer, Tunnel runtime key, workspace tool authority, DPAPI plaintext, or MCP request data.

The Rust shell writes a per-launch `scr.host-guardian-control/v1` record under the app-data `guardian` directory. The token binds `running`, `restart`, and `exit` intent to that shell launch. A tray Exit writes intentional shutdown before the shell disappears. If the shell vanishes without that intent, or if the Rust-side health monitor detects a dead Runtime Host process/protocol, the Guardian starts the exact same shell with `--guardian-restart`.

The shell health monitor checks Runtime Host process/protocol state every five seconds, performs a bounded `state.get` ping every fifteen seconds, and requests a Tunnel refresh every thirty seconds. Runtime Host loss restarts the complete shell/runtime/Gateway/Tunnel lifecycle rather than attempting to mutate an orphaned sidecar in place. Process exit or a protocol violation restarts at once. A Runtime Host that is alive but slow to answer is not treated as lost until six consecutive pings, about ninety seconds, go unanswered, and a ping missed while the monitor itself was stalled does not count: restarting a host that was only busy cut the tunnel and cancelled the work running in it.

Crash-loop control is persistent across restarted shell processes. The Guardian permits no more than five restarts inside a rolling ten-minute window, then writes a `circuit-open` incident and stops. Each restart, restart failure, or open circuit is recorded in `guardian/last-incident.json`; no secret values are included. This is a local availability boundary, not a substitute for a signed updater or A/B release rollback.

The Runtime Host's stderr is held only in the shell's memory, so when the health monitor finds the host unhealthy it first writes `guardian/last-runtime-failure.json` (`scr.runtime-host-failure/v1`), once per Runtime Host instance and whether or not the Guardian then restarts: the reason, instance and process IDs, exit code (null while the process still runs), uptime, the shell's error message, and the bounded stderr tail. The launch's protocol session secret and Gateway Bearer are replaced with `[redacted]` before the record reaches disk.

The normal main-window close request is intercepted and hides the workbench to the Windows notification area. Only the tray Exit path intentionally stops the Runtime Host, Gateway, Tunnel, managed processes, and Guardian. Isolated smoke, approval-smoke, benchmark, and packaged Guardian test modes disable ordinary tray/single-instance behavior where required for deterministic testing.

### Host availability diagnostics

`availability.rs` is a trusted-shell diagnostics component, not a new authority plane. Every five seconds it samples Windows `GetSystemPowerStatus`, `GetTickCount64`, and a monotonic Rust clock. A monotonic scheduling gap of at least 20 seconds is recorded as `possible-suspend-or-stall`; the product deliberately does not label this as an exact suspend/resume event because long CPU starvation or debugger suspension can produce the same observation.

The same monitor consumes bounded Runtime Host state snapshots and derives a sanitized Tunnel recovery state: `not-configured`, `offline`, `connecting`, `retrying`, `ready`, or `degraded`. It records transitions from Ready to loss and back to Ready, including the observed outage duration and reconnect schedule. A possible suspend/stall gap triggers an immediate `tunnel.refresh` call instead of waiting for the normal thirty-second cadence.

At most 32 non-secret events are persisted beneath the application data root in `host-availability.json`. The file contains timestamps, event classes, bounded explanatory text, and durations only. It never contains the Gateway Bearer, Tunnel runtime key, proxy URL/credentials, workspace contents, MCP payloads, or approval data. The Tauri startup-state DTO exposes the current snapshot and event tail to the Remote Host and Diagnostics UI. The legacy Electron adapter reports the monitor as unavailable rather than fabricating protection.

## Runtime core

`packages/runtime-core` owns:

- capability identifiers;
- principals and workspace grants;
- policy decisions;
- `RuntimePermissionProfile` and permission ranking;
- structured public errors;
- canonical JSON and SHA-256 manifest identity;
- audit receipt interfaces/stores;
- `scr.run/v1` lifecycle records;
- in-memory and SQLite run stores with interrupted-run recovery.

`RuntimePermissionProfile` is:

```text
observe | workspace | consequential | bypass
```

Tool risk remains three-level. L4 is a user-selected execution profile rather than a fourth tool risk classification.

## Toolkit

`packages/toolkit` converts reviewed primitives into MCP tools. Each definition supplies:

- stable tool name/version/category;
- description and input JSON Schema;
- Zod runtime validation;
- required capabilities;
- side-effect/destructive hints;
- L1/L2/L3 permission metadata;
- workspace extraction;
- primitive executor.

The same definition drives the manifest, policy, MCP registration, and local first-party invocation. This avoids duplicating security metadata between the web-agent path and the desktop UI path.

## Windows Adapter

`packages/windows-adapter` is the only layer that directly manipulates authorized workspace paths or launches local processes.

### Filesystem containment

Resolution is two-stage:

1. lexical checks reject forbidden Windows path forms;
2. existing components are checked with `lstat`/`realpath` against the canonical workspace root.

Symbolic links and junctions are rejected rather than followed. Creates require an existing contained parent. Replacement, exact replacement, move, and deletion use digest guards where appropriate.

### Processes and runs

Validation, PowerShell, Python, and workflows use a managed process/run layer with:

- bounded output;
- timeout;
- Windows process-tree cancellation;
- SQLite `scr.run/v1` persistence;
- interrupted-run recovery after restart.

Interactive terminals use the packaged C# native helper and Windows ConPTY. The current helper uses a native command bridge so interactive input can be submitted reliably while preserving resize, output, close, and process-tree lifecycle behavior.

### Browser

Managed browser sessions use temporary Microsoft Edge profiles and loopback CDP. They enforce explicit domain allowlists, block disallowed requests/redirects, expose semantic element refs, require fresh observation revisions for mutations, and refuse credential/one-time-code entry for human handoff.

### Computer Use

The C# native helper captures bounded desktop/window observations and executes revision-bound focus, click, text, key, and contained `.exe` launch actions. It is intentionally smaller than a full Windows UI Automation agent and does not cross Secure Desktop/elevation/credential boundaries.

## Secure MCP Tunnel

`packages/control-plane/src/secure-tunnel.ts` supervises the optional official OpenAI `tunnel-client` without embedding it into the current package. The primary Tauri shell supplies the operator-facing picker, trust confirmation, and Windows-DPAPI protected-secret port; the legacy Electron shell supplies the equivalent port through `safeStorage`.

Executable discovery is intentionally explicit and bounded:

```text
SCR_TUNNEL_CLIENT_PATH
  -> future packaged resources/tunnel-client/tunnel-client.exe
  -> where.exe tunnel-client.exe
```

Starting the tunnel requires an active loopback Sovereign Gateway, a valid `tunnel_id`, and a runtime API key available to the trusted Runtime Host. When Windows-protected storage is available, encrypted settings remain under the shared desktop user-data root; the Runtime Host requests restoration through the shell-only secret port. The primary Tauri shell uses Windows DPAPI for that port, while the legacy Electron shell uses `safeStorage`; plaintext crosses only the authenticated private child protocol for active tunnel use. An optional primary HTTP/HTTPS OpenAI control-plane proxy and an advanced backup proxy use the same protected-secret path. Direct fallback is a non-secret explicit preference and defaults off. Sovereign launches `tunnel-client run` from the Runtime Host with one route selected by the control-plane coordinator. The current Sovereign Bearer is supplied through `MCP_EXTRA_HEADERS` and `MCP_DISCOVERY_EXTRA_HEADERS` using an environment reference so it does not appear in the command line or a persisted profile. On a proxy route, `CONTROL_PLANE_HTTP_PROXY` references a child-only environment variable for that route; on direct fallback it is absent. `MCP_SERVER_URL` remains the direct loopback Gateway URL in every case.

Each controller launch creates a random per-instance attempt directory. Every connector generation receives unique `HEALTH_URL_FILE` and `PID_FILE` paths; health probes, stdout/stderr callbacks, process errors, and close events are accepted only while both the generation and exact child identity remain current. A health-file timestamp older than the attempt is rejected. This prevents a late child, stale health file, or prior shell instance from mutating the active connector state.

Before launch, Sovereign removes inherited proxy and connector configuration variables case-insensitively, then explicitly sets loopback `NO_PROXY` and the managed Gateway/Tunnel values. `MCP_SERVER_URL` remains the direct loopback endpoint. Connector output is buffered by complete line, redacted for runtime/Gateway/proxy values and authorization material, and only then retained under the bounded log-tail limit; an oversized unterminated line is discarded rather than retained indefinitely.

A bounded structured classifier converts already-redacted connector lines, `/readyz` status/body evidence, spawn/process errors, health-file failures, and local health-probe failures into `scr.tunnel-failure/v1`. The classes are `transport`, `auth`, `identity`, `local-mcp`, `connector`, and `unknown`. Only explicit high-confidence control-plane transport evidence is route-switch eligible. The diagnostic is exposed to desktop state and the Web Agent surface; the connector supervisor preserves the strongest evidence within one process generation, while the route coordinator reports the current route's terminal diagnosis rather than a stale failure from the route that was left. Reaching Ready clears the current attempt diagnostic.

Sovereign requests an ephemeral loopback health listener and reads the generation-bound client-written health URL. `/readyz` is polled with a short timeout to distinguish `starting`, `running`, and `ready`; failure is not treated as proof that the proxy route failed because readiness also includes non-network gates. While a child remains alive, ordinary network reconnection remains delegated to the official connector. In single-route mode, unexpected connector exit uses bounded same-route backoff. In classified multi-route mode, the controller disables the child supervisor's independent reconnect loop and applies one deterministic reducer: connector failure retries the same route once; the first confirmed transport failure retries the same route; the thresholded confirmed transport failure may move to an eligible backup or explicit direct fallback; non-routable failures enter `needs-attention`; exhausted routes or switch budget enter `circuit-open`. The old process tree is retired before the next route launches, and the local Gateway remains running throughout a remote-route failure. An explicit Stop invalidates the route and connector generations, cancels timers, confirms child termination, and clears attempt files. Stopping/restarting the Gateway, rotating its credential, changing configuration or workspace, or shutting down the desktop stops routing first so a child process cannot retain a stale local endpoint, route, or Bearer credential.

Remote Host Mode adds current-user Windows login startup for the exact shell executable. It starts only after that user signs in, launches hidden when invoked with `--autostart` or `--guardian-restart`, uses single-instance protection for ordinary launches, keeps window-close in the notification area, and delegates unexpected shell/Runtime Host recovery to the Host Guardian. It is intentionally not a pre-login service, sleep inhibitor, power-loss recovery layer, offline job queue, or L3 approval-persistence mechanism. Restored L4 is limited to a locally confirmed, current-user DPAPI-protected, exact-workspace grant and remains subject to the same Windows account, workspace, audit, and containment boundaries.

The current installer does not bundle the third-party tunnel binary. This keeps the runtime dependency explicit until binary provenance/update policy is deliberately chosen.

## Connection bundles

The desktop generates `scr.connection/v1` bundles containing a Streamable HTTP endpoint and the transient Bearer credential for local MCP clients or the fallback direct HTTPS reverse-bridge mode. Secure MCP Tunnel uses its tunnel ID instead of this bundle.

Accepted endpoint forms are:

```text
http://127.0.0.1:<port>/mcp
http://localhost:<port>/mcp
https://<remote-trusted-bridge>/.../mcp
```

Remote plain HTTP is rejected. Endpoints containing embedded credentials, query strings, or fragments are rejected. The configured ChatGPT Web bridge must be remote HTTPS and end in `/mcp`.

When a bridge URL is configured, **Copy MCP connection** targets that remote URL; otherwise it targets the local loopback Gateway for local MCP clients. Clipboard content is cleared after a bounded TTL when unchanged.

## Data and secrets

Persisted desktop settings contain the authorized workspace, its workspace-bound permission selection and L1-L3 fallback, the optional current-user DPAPI-protected exact-workspace L4 grant, the separate unattended binding, Gateway/Tunnel automation preferences, optional Secure MCP Tunnel ID, operator-selected connector path and pinned connector digest, optional fallback remote bridge URL, and—when Windows protected storage is available—only encrypted ciphertext for the Secure MCP Tunnel runtime API key and optional primary/backup control-plane proxies. The non-secret direct-fallback preference may also be persisted. Current-user Windows login startup is stored separately in the Windows `Run` registry key and binds to the exact shell executable path.

Not persisted in plaintext:

- Gateway Bearer credential;
- Secure MCP Tunnel runtime API key;
- OpenAI control-plane proxy URL or embedded proxy credentials;
- L3 approvals, direct-tool session approvals, or plaintext L4 authorization material;
- model endpoint/model/API key, because no built-in model client exists;
- ChatGPT conversation state.

The tunnel runtime key remains present in trusted-process memory while needed for an active desktop session. Windows account protection is an at-rest control and does not claim to protect against malicious code already running as the same Windows user.

SQLite audit receipts and run records live beneath the desktop user-data root shared with the Runtime Host. The renderer receives only bounded summary/detail fields required by its UI.

## Packaging

The primary package is now `apps/desktop-tauri`. Vite builds the multipage WebView2 workbench and dedicated approval page; Cargo builds the Rust Tauri host. `prepare-runtime.mjs` rebuilds the C# native helper, bundles the single-file Node Runtime Host, stages the machine's current Windows `node.exe`, and fingerprints the Host Guardian script. Tauri resources map that portable Node runtime, `runtime-host.cjs`, `host-guardian.mjs`, the resource manifest, and `SovereignNativeAgent.exe` beside the release application. `package-portable.mjs` then produces a self-contained portable folder under `apps/desktop-tauri/artifacts/portable-*`; packaged startup does not depend on Electron or a system `node` command. Its `scr.portable-package/v2` manifest records Git provenance, dirty state, synchronized product metadata, and SHA-256 plus byte length for every component. A structured latest-package pointer binds the selected folder to the manifest digest. Portable verification enforces contained unique paths, exact component hashes, executable metadata, and aggregate size before any smoke launch. The verified root build runs both the renderer/Gateway portable smoke and a destructive isolated Guardian smoke that kills the packaged Runtime Host, requires a fresh shell/Runtime Host/Gateway, and confirms all test processes exit. The OpenAI `tunnel-client` is deliberately not bundled.

Tauri can additionally emit an NSIS installer through `pnpm make:windows`; the first NSIS build may require Tauri's NSIS bundle tooling to be present or downloadable. The legacy Electron Forge package remains available through explicit `legacy-electron` scripts only.

The desktop application is the primary product because it owns local authorization and execution visibility. The headless Gateway remains secondary and does not provide the native L4 activation UX.

## Deferred work

Current self-use scope intentionally defers:

- bundling/updating the official tunnel-client binary and automatic tunnel provisioning through OpenAI Platform;
- replacing direct Edge/CDP with Playwright;
- OS-level Python/network sandboxing;
- persisted workflow DAG editing/scheduling/resume;
- sleep inhibition, exact OS suspend/resume event subscription, and pre-login Windows service hosting;
- multi-project registry/session isolation and Git-worktree task isolation;
- signed A/B self-update with candidate health verification and automatic rollback;
- richer Windows UI Automation semantics;
- Secure Desktop/elevation/password/OTP/passkey/CAPTCHA handling;
- remote accounts, quotas, entitlements, multi-user governance, analytics, and auto-update;
- release-grade code signing.

Future work must preserve the current capability, workspace, profile, audit, run, and revision boundaries.
