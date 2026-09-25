# Threat Model

## Protected assets

- files beneath the desktop-selected workspace root;
- transient Gateway credentials and principal identity;
- capability and workspace grants;
- integrity of guarded file updates;
- MCP session identity;
- local process execution boundary;
- audit receipt history;
- trusted Tauri Rust shell authority and authenticated Runtime Host sidecar boundary;
- Host Guardian launch intent, bounded restart history, and incident evidence;
- bounded host-availability timing evidence and its integrity as a diagnostic record;
- desktop settings and selected workspace identity.

## Trust boundaries

1. **Renderer to Tauri command boundary.** Renderer content is untrusted and receives only the commands permitted by its window capability; the dedicated approval window has a separate two-command capability.
2. **Tauri Rust host to Runtime Host.** The shell and Node sidecar use a private versioned JSONL protocol over child stdio with a fresh session secret, bounded messages, sender/method validation, and fail-closed shutdown on channel loss.
3. **Tauri shell to Host Guardian.** A separate packaged Node process receives only the shell PID/path, bounded restart arguments, state paths, and a fresh per-launch token. It never receives MCP credentials or execution authority.
4. **Human workspace selection to adapter configuration.** A native folder choice becomes the only authorized root; arbitrary renderer-supplied host paths are not accepted.
5. **MCP client to HTTP Gateway.** Requests remain untrusted until Host, optional Origin, and Bearer authentication succeed.
6. **Gateway to session.** A session identifier is untrusted until it is found and bound to the same principal.
7. **Tool input to policy.** Valid input does not imply authority. Capability and workspace checks run before execution.
8. **Policy to Windows Adapter.** The adapter independently enforces containment and write policy.
9. **Lexical path to filesystem path.** Windows syntax is validated before lookup, and existing components are resolved independently.
10. **Runtime to child process.** Only declared tool/process shapes cross into Windows execution; Tunnel launch uses a pinned executable digest and child-only environment values.
11. **Windows login startup to shell executable.** The current-user `Run` value is useful only when it exactly matches the active executable plus `--autostart`; stale or moved portable paths are reported rather than treated as healthy.
12. **Write result to audit ledger.** Every attempted write records success, failure, or denial.

## Adversary capabilities

The design assumes an attacker may:

- inject script into renderer content or attempt to navigate the window;
- invoke exposed preload methods with malformed values;
- attempt to open external windows, webviews, or permission prompts;
- send arbitrary HTTP headers and JSON-RPC bodies to the loopback port;
- guess, replay, or steal an MCP session identifier without the associated credential;
- supply malicious workspace-relative paths;
- place files, directories, symbolic links, or junctions inside a writable workspace;
- race guarded replacement with another local writer;
- cause large files, output, or deep directory trees;
- request tools outside the principal's capability set;
- attempt to turn fixed validation or Git operations into arbitrary shell execution;
- move or replace a portable executable after Windows login startup was registered;
- terminate `tunnel-client`, the Runtime Host, or the desktop shell repeatedly to induce restart churn;
- replay or tamper with stale Host Guardian control/history files or the non-secret availability event file;
- provide a proxy URL containing embedded credentials and then attempt to recover those credentials through renderer-visible state.

The current self-use build does not claim to defend against a fully compromised Windows user account, administrator, injected native code inside trusted desktop/runtime processes, or modification of installed executable files.

## Desktop controls

### Renderer isolation

- the primary Tauri/WebView2 renderer has no Node.js or raw filesystem/process/database/credential API;
- a restrictive Content Security Policy permits only packaged local resources and Tauri IPC;
- the `main` window capability exposes only workbench commands;
- the dedicated `approval` window capability exposes only `approval_current` and `approval_resolve`;
- approval navigation is constrained and the approval window is non-resizable, parent-bound, and destroyed on completion or failure;
- the legacy Electron shell retains sandbox/context-isolation controls for rollback and regression coverage.

### Typed shell boundary

- renderer calls cross only explicit Tauri commands with typed JSON values;
- sensitive lifecycle and tool operations are forwarded over the authenticated private Runtime Host protocol rather than exposing Node APIs to WebView content;
- renderer values cannot select an arbitrary filesystem path because workspace selection is performed by a native shell dialog;
- audit and manifest data are reduced to display summaries before crossing into the renderer.

### Credential handling

- the Runtime Host generates a fresh high-entropy credential for each desktop-managed Gateway launch;
- the Gateway credential remains only in trusted Runtime Host process memory;
- it is not written to settings or rendered in the UI;
- stopping the runtime drops the Gateway credential and invalidates the associated listener;
- the Secure MCP Tunnel runtime API key and optional primary/backup OpenAI control-plane proxies may be persisted only as Windows-account-protected ciphertext: DPAPI in the primary Tauri shell, or `safeStorage` in the legacy Electron shell;
- the tunnel key and proxy values are restored into trusted-process memory only for tunnel use, and plaintext is never written to settings;
- proxy credentials are never returned to the renderer; the UI receives only credential-free protocol/host display values;
- if Windows secret protection fails, a key or proxy may remain memory-only for that application session, while encrypted settings remain null and plaintext is not written to disk;
- changing the selected connector clears its pinned trust digest so the replacement executable must be reviewed again.

### Remote Host Mode and startup

- login startup is current-user only and does not require or obtain administrator elevation;
- the registered command contains only the exact shell executable path and `--autostart`; it contains no Gateway Bearer, Tunnel runtime key, proxy URL, or workspace command;
- startup health compares the registered command with the current executable and reports stale registrations;
- portable builds warn that moving or deleting the folder invalidates login startup; installed builds are preferred for remote deployment;
- normal Tauri launches are single-instance so repeated login/manual starts cannot create parallel Gateway and Tunnel trees;
- smoke, approval-smoke, benchmark, and packaged Guardian integration processes opt out explicitly through bounded test environment variables so production single-instance behavior is not weakened;
- `--autostart` and `--guardian-restart` hide the workbench after launch but do not alter or elevate the external permission profile; the Runtime Host restores only the workspace-bound L1-L3 selection whose normalized binding matches the current authorized root;
- a normal main-window close request is prevented and hides the window to the notification area; tray Exit is the explicit full-shutdown path;
- the Host Guardian control record carries a fresh 256-bit token and only bounded lifecycle intent; it contains no Gateway Bearer, Tunnel key, proxy credential, or workspace command;
- intentional Exit shuts down the Guardian before the shell disappears, while Runtime Host process/protocol failure writes restart intent before the shell exits;
- stale control records cannot authorize the current launch because the per-launch token and control filename change.

### Availability diagnostics

- the Tauri host samples Windows power source and system uptime in trusted Rust code; renderer content cannot supply these values;
- a monotonic heartbeat gap of at least 20 seconds is labelled only as `possible-suspend-or-stall`, because debugger suspension or severe CPU starvation can be observationally equivalent;
- such a gap triggers an immediate bounded Tunnel refresh, but does not grant authority, resume an interrupted task, or bypass connector trust;
- network diagnostics are derived from bounded Runtime Host/Tunnel state and contain only phase, timing, retry, and sanitized error summaries;
- at most 32 events and 128 KiB are accepted from `host-availability.json`; malformed, oversized, or unknown-schema files are ignored;
- the availability file never contains Gateway Bearers, Tunnel runtime keys, control-plane proxy values, MCP payloads, workspace content, or approvals;
- this file is operational evidence rather than tamper-proof audit evidence: another process running as the same Windows user can modify or delete it.

### Tunnel recovery

- only an already trusted connector with a matching pinned SHA-256 can auto-start without a new prompt;
- each controller process uses a random instance directory, and each connector launch uses a monotonically increasing generation with unique health and PID files;
- callbacks, health-file reads, HTTP probe results, and close/error events are ignored unless they match both the current generation and exact child identity;
- inherited proxy, MCP target/header, health, PID, logging, and OpenAI credential variables are removed case-insensitively before managed child values are added;
- loopback `NO_PROXY` is explicit, and connector output is retained only after complete-line buffering and secret/header/user-info redaction;
- an unexpected connector exit uses bounded delays and reaches a five-minute maximum rather than an unbounded tight restart loop;
- an explicit Stop, Gateway stop, credential rotation, workspace change, or application shutdown cancels desired-running state and pending retries;
- process-exit supervision is separate from the local Gateway phase, so an unavailable remote route does not make a healthy loopback runtime appear failed;
- primary and backup control-plane proxy secrets share the Windows-protected ciphertext or memory-only boundary; backup and explicit direct fallback require an existing primary route, and clearing the primary atomically removes both dependent settings;
- the active control-plane proxy is injected only for the official OpenAI control plane; `MCP_SERVER_URL` remains the direct loopback endpoint on every route;
- bounded, already-redacted evidence is classified into transport, authentication, identity, local-MCP, connector, or unknown diagnostics; route coordination evaluates the current attempt's evidence rather than retaining a stale prior-route diagnosis;
- only explicit high-confidence control-plane transport evidence may enter the retry/switch state machine; `/readyz` failure alone is never sufficient;
- the first confirmed transport failure retries the same route, the thresholded failure may switch to an eligible backup, and explicit direct fallback participates only when locally enabled;
- authentication, identity, local-MCP, connector, and unknown failures stop for local attention without trying another proxy;
- route dwell, cooldown, switch-budget, generation checks, and a remote-route circuit prevent flapping; when all configured routes fail, the local Gateway remains running;
- explicit Stop, credential/configuration change, workspace change, Gateway shutdown, and application shutdown cancel pending route launches and invalidate late attempt events.

## Gateway controls

### Authentication and routing

- configured credentials are hashed before comparison;
- digests are compared with `timingSafeEqual`;
- missing and invalid credentials return `401`;
- forwarded Host is rejected;
- Host is mandatory and allowlisted;
- Origin is validated when present;
- sessions are bound to the initializing principal;
- the desktop listener binds to `127.0.0.1` on an ephemeral port.

### Authorization

- capabilities use stable identifiers;
- workspace access is independent from capability access;
- the remembered L1-L3 profile is restored only when its normalized workspace binding matches the current authorized root; a mismatch fails closed to L1 and clears unattended access;
- persisted settings may contain L1/L2/L3 directly and may contain L4 only with a current-user Windows-DPAPI-protected grant bound to the exact normalized workspace after native local confirmation; invalid or mismatched grants fail back safely;
- every facade declares required capabilities;
- the catalog applies policy before execution;
- write primitives repeat capability checks for defense in depth.

## Windows containment controls

Rejected before filesystem access:

- `.` and `..` segments;
- absolute and root-relative paths;
- drive-qualified paths such as `C:\...`;
- UNC paths such as `\\server\share`;
- Win32 device paths such as `\\?\...` and `\\.\...`;
- NTFS alternate data stream separators;
- control characters and invalid Win32 filename characters;
- trailing spaces or periods;
- reserved devices such as `CON`, `NUL`, `COM1`, and `LPT1`.

For allowed lexical paths, the adapter:

- canonicalizes the configured workspace root;
- verifies every existing component with `lstat`;
- rejects symbolic links and junctions;
- calls `realpath` after each component;
- checks every resolved path remains beneath the canonical root;
- requires the parent directory to exist for creation;
- opens new files with exclusive creation.

## Guarded replacement

- only regular files are replaceable;
- current bytes are read through the opened file handle;
- the current SHA-256 digest must match the supplied lowercase digest;
- stale digests return `409 STALE_HASH`;
- the same handle writes and truncates the replacement;
- successful receipts include before and after digests.

Windows does not expose a portable Node.js equivalent of POSIX `O_NOFOLLOW`. Component checks and same-handle updates substantially reduce risk, but a hostile same-user process able to race filesystem metadata remains inside the local-account compromise boundary. A future native C#/.NET adapter can use stronger handle-based reparse-point controls.

## Resource and process bounds

- path, input, file, result, and process-output sizes are bounded;
- search has file and result limits;
- generated directories and links are skipped;
- child processes have timeouts and bounded output;
- Windows process-tree cancellation uses a short startup grace period plus bounded `taskkill /T /F` retries before fallback;
- Secure MCP Tunnel restart delays are bounded at 2, 5, 10, 30, 60, 120, then 300 seconds, and an explicit stop cancels the timer;
- the Rust shell checks Runtime Host health every five seconds, uses a five-second bounded protocol ping every fifteen seconds, and requests a bounded Tunnel refresh every thirty seconds;
- availability evidence is capped at 32 events and 128 KiB, and a possible suspend/stall gap causes only one immediate bounded Tunnel refresh;
- the Host Guardian permits at most five shell restarts in a rolling ten-minute window, then records `circuit-open` and stops rather than spinning indefinitely;
- only one normal Tauri application instance may own the Runtime Host and Gateway for the current product identity;
- MCP sessions are capped at 128 by default, reclaim five-minute-idle sessions under capacity pressure, and expire after 30 minutes of ordinary inactivity;
- sessions with in-flight requests are never reclaimed for capacity or idle expiry;
- arbitrary PowerShell/Python/terminal execution exists only through explicitly declared consequential tools and remains capability/profile/approval gated;
- the renderer cannot launch child processes directly; process creation occurs only behind trusted shell/control-plane commands.

## Audit

Every file create or replace attempt produces one receipt, including policy denials and stale-hash failures. Receipts omit full file content and Gateway credentials. The desktop renderer receives bounded receipt summaries, while SQLite access remains in the trusted process.

## Residual risks and next controls

- Remote Host Mode is post-login automation, not a Windows service: the Windows user must sign in and remain signed in;
- close-to-tray and process-crash recovery are implemented, but Sovereign does not inhibit sleep, start before user sign-in, recover a powered-off host, or guarantee recovery from OS/kernel/hardware failure; possible sleep/stall gaps are heuristic observations after resume, and explicit tray Exit intentionally stops the complete tree;
- there is no offline remote task queue or automatic resumption of interrupted work;
- the remembered L1-L3 profile is useful local configuration rather than an approval grant: it is restored only for the exact separately bound workspace, and every L3 consequential call still requires a fresh native decision. Remembered L4 is an explicit operator-selected convenience boundary protected at rest by current-user DPAPI and exact-workspace validation; it does not defend against malicious code already running as the same Windows user and never disables audit or containment;
- another process already running as the same Windows user may inspect process environments or protected data after DPAPI decryption; Windows account protection is an at-rest boundary, not a same-user compromise boundary;
- an outbound proxy can change network routing but does not establish provider-supported region/account status or guarantee availability on a destination ISP;
- protect the SQLite database with Windows access controls when multiple identities share a machine;
- keep Windows-protected secret storage behind the existing shell-port abstraction and preserve compatibility across the primary Tauri and legacy Electron adapters;
- add replay-resistant approval tokens before destructive, shell, network, browser, or desktop tools;
- move arbitrary or long-running worker execution into dedicated utility/native processes;
- implement a separate narrowly scoped consequential allowlist before attempting no-human PowerShell, Python, browser, workflow, or desktop-control operation;
- add sleep inhibition, exact OS suspend/resume event subscription, and a signed A/B candidate-update rollback path before claiming unattended multi-week self-updating availability;
- implement native Windows handle and reparse-point checks in the future C#/.NET agent;
- add receipt chaining or signing if tamper evidence against the local user becomes a requirement;
- sign Windows installers before production distribution.
