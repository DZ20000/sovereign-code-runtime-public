# Signed renderer-only hot updates

## Scope

Sovereign can replace the Tauri/WebView2 **renderer bundle** without restarting the Runtime Host, Gateway, Secure MCP Tunnel, managed runs, Task Broker, or native shell. This mechanism is intentionally separate from live tool-pack work and from full executable updates.

The boundary is:

```text
stable signed Tauri/Rust shell
  -> bounded trusted Ed25519 public-key registry
    -> locally supplied signed renderer package
      -> immutable renderer slot
        -> hidden read-only preflight webview
          -> main-webview activation with bounded UI handoff
            -> automatic last-known-good rollback on readiness failure
```

It does not load JavaScript from a URL, workspace, npm package name, arbitrary path, or MCP response. This checkpoint contains no network downloader. An operator or trusted release process supplies a complete package under the local renderer inbox.

Tauri/Rust, Node, Host Guardian, Preload trust-boundary, and native-agent changes use the signed side-by-side executable update path and a controlled restart; see [`signed-update.md`](signed-update.md). Runtime Host JavaScript bundles use the separate [signed Runtime candidate path](runtime-candidate-updates.md).

## Default posture

The repository does not carry a production renderer trust key. `prepare-renderer-trust.mjs` generates the Tauri resource at:

```text
apps/desktop-tauri/runtime-resources/renderer-trusted-keys.json
```

A normal development build runs:

```powershell
pnpm --filter @sovereign/desktop-tauri prepare:renderer-trust
```

and writes the explicit disabled registry:

```json
{
  "schemaVersion": "scr.renderer-trusted-keys/v1",
  "keys": []
}
```

`build.rs` creates the same disabled fallback only when the generated resource is absent, so direct `cargo check` remains deterministic. It never invents or downloads a key.

A renderer-enabled production shell must set `SCR_RENDERER_TRUSTED_KEYS_PATH` to a bounded regular JSON file containing canonical Ed25519 SPKI public keys and run one of the release-enforcing commands:

```powershell
pnpm --filter @sovereign/desktop-tauri prepare:renderer-trust:release
pnpm --filter @sovereign/desktop-tauri tauri:build:renderer-enabled
pnpm --filter @sovereign/desktop-tauri package:portable:renderer-enabled
pnpm --filter @sovereign/desktop-tauri package:installer:renderer-enabled
```

The release preparation fails when the source is missing, empty, malformed, contains a private key, or contains zero trusted keys. The generated resource is then bundled **inside the signed shell**. The private signing key must never be present on a target machine, in application resources, in user data, in an authorized workspace, or in an MCP-visible environment.

Each trusted key is bounded by:

```text
keyId
algorithm = ed25519
canonical publicKeyPem
minimumReleaseSequence
maximumReleaseSequence or null
allowedChannels
```

Key rotation or trust-policy expansion requires a normal signed shell update. A renderer cannot add its own signing key.

## Signed package

A renderer package has exactly this outer shape:

```text
<releaseId>/
  envelope.json
  bundle/
    index.html
    approval.html
    assets/...
```

`envelope.json` uses `scr.renderer-release-signature/v1` and contains a `scr.renderer-release/v1` manifest. The signature is Ed25519 over the domain-separated payload:

```text
SCR-RENDERER-MANIFEST-V1\n<canonical-manifest-sha256>
```

The manifest contains:

```text
releaseId
releaseSequence
version
channel
createdAt
entrypoint = index.html
totalBytes
components[] { path, sha256, bytes }
compatibility {
  minimumShellVersion
  maximumShellVersion
  bridgeApiVersion
}
```

The implementation rejects unknown signed fields, malformed or noncanonical signatures, unknown keys, disallowed channels or sequences, incompatible shell/bridge versions, path traversal, drive/UNC/device paths, alternate separators, Windows reserved names, symbolic links, junctions/reparse points, hard-linked source files, duplicate case-folded names, file/directory conflicts, extra files, extra empty directories, oversized payloads, and any component digest mismatch.

Current limits are:

```text
256 files
32 MiB per file
256 MiB total renderer payload
512 KiB signature envelope
256 KiB trusted-key registry
```

## Building and signing a package

Build the Tauri web bundle first. Vite uses `base: "./"`, so generated asset URLs remain inside the release namespace when served through the custom protocol.

The package command builds the web bundle and `@sovereign/update-core`, then signs an immutable renderer package:

```powershell
pnpm --filter @sovereign/desktop-tauri package:renderer-update -- `
  --private-key D:\secure-offline\renderer-ed25519-private.pem `
  --trusted-keys apps\desktop-tauri\src-tauri\renderer-trusted-keys.json `
  --key-id renderer-prod-2026 `
  --release-id renderer-00000042 `
  --sequence 42 `
  --version 0.4.2 `
  --channel stable `
  --minimum-shell-version 0.1.0 `
  --maximum-shell-version 0.9.0 `
  --bridge-api-version 1
```

The default output is:

```text
apps/desktop-tauri/artifacts/renderer-updates/<releaseId>/
```

The output directory name must exactly match the lowercase signed release ID. Existing output is never overwritten unless `--replace` is explicit; replacement is accepted only when the existing directory is itself a correctly shaped package with a trusted envelope for the same release ID. Supplying `--trusted-keys` verifies the finished envelope against the exact registry intended for the target shell; omitting it verifies only against the public key derived from the supplied private key and is less suitable for production release checks.

The private key path must resolve outside the source workspace to one bounded, direct, single-link regular file. On Unix it must not be group- or world-accessible. The script imports the key into Node's crypto provider and immediately overwrites the temporary byte buffer; the private key is never included in package output.

The packaging script snapshots every regular file, rejects links and containment escapes, signs the canonical manifest, writes a cryptographically random fresh staging directory, re-reads and verifies every packaged component and the final envelope, and only then renames the staging directory to the final release directory.

## Supplying a package to a host

The target renderer storage root is the Tauri application-data directory plus:

```text
renderer-updates/
```

For debug builds only, `SCR_RENDERER_UPDATE_ROOT` can override the root. Production builds ignore this override.

Copy one complete package directory into:

```text
renderer-updates/inbox/<releaseId>/
```

The inbox directory must contain only `envelope.json` and `bundle/`. Installation is initiated locally from **Settings -> Diagnostics -> Renderer updates**. A workspace, connected Agent, or remote MCP client has no renderer-install command.

### Release coordination

For a new Renderer release, build and sign from a committed, immutable source snapshot outside the managed inbox. An immutable snapshot does not require creating another worktree. Coordinate a release freeze with affected project Tasks, publish the complete candidate under `inbox/<releaseId>`, then acquire the candidate-bound lease with `scripts/renderer-release-guard.mjs` before installation, hidden preflight, or activation. Acquisition reads the staged envelope, so it cannot precede candidate staging. Coordinate inbox publication and release ownership to avoid concurrent writers.

Record the originating Task ID, full source commit, owner principal, signed manifest digest, release ID, and sequence. The new sequence must exceed the durable `highestReleaseSequence`, not merely the current active sequence; failure or rollback does not lower this floor. Refuse an older target when a newer candidate exists. Preserve the active and target packages, and move older inbox candidates into reversible quarantine with a receipt.

While the hot-update lease is held, do not restart the Shell. Completion requires the intended durable active revision and slot, no `lastFailure`, an unchanged Shell PID, and the rendered UI after readiness. Complete or fail the lease explicitly, preserve its audit record, and notify affected Tasks before lifting the freeze. Building, staging, or installing alone is not activation success.

These are the repository's release-coordination rules. The additional native enforcement for development candidates is described below.

#### Development candidate gate

A `development` candidate has one additional Shell-owned gate. Before the first slot write, before opening its hidden preflight, and again before publishing activation state, the production Shell re-reads the canonical release records:

```text
renderer-updates/coordination/activation-lease.json
renderer-updates/coordination/releases/<releaseId>.json
```

The lease must still be held and unexpired, target the exact signed release ID, sequence and manifest digest, retain the same origin Task, owner principal, source commit and lease ID as the provenance record, bind the current Sovereign Shell PID, preserve the durable previous-active baseline, and require committed-source, monotonic-sequence and origin-Task policy. The provenance candidate directory must be the exact direct child under `inbox/`; links, shared records, path escapes and changed identities fail closed. A failed install check occurs before `slots/.install-*` is created. Preflight and activation re-read the records rather than trusting the earlier install decision, so an expired lease, changed Shell, changed active baseline or replaced provenance blocks later execution.

This extra local gate applies to `development` releases. Stable and beta packages remain governed by the signed manifest, trusted-key channel/sequence policy, immutable slot verification, preflight and activation journal rules.

`sourceCommit` is currently an audit-provenance field shared by the lease and provenance record; it is not part of the signed Renderer manifest. Release coordination therefore proves that the Shell consumed one internally consistent clean-snapshot claim, while the signed manifest proves the exact executable bytes. If a future threat model requires cryptographic binding between those facts, the correct extension is a reviewed signed-manifest field. A second parallel lease/manifest-binding/settlement protocol must not be introduced for that purpose.

## Install transaction

For an accepted install, the Rust shell:

1. validates the exact inbox shape;
2. reads the bounded envelope;
3. verifies the Ed25519 signature against the shell-owned registry;
4. validates shell, channel, sequence, and bridge compatibility;
5. verifies the complete bundle inventory before copying;
6. copies each file into a unique `slots/.install-*` directory with exclusive creation;
7. writes shell-owned `.scr-renderer/envelope.json` and `ready.json` metadata;
8. closes all file handles and re-verifies the complete staged slot;
9. atomically renames the stage to `slots/<releaseId>`;
10. verifies the published slot again before exposing it as installed.

Installed slots are immutable by contract. The custom protocol re-opens, bounds, and SHA-256-verifies a requested component on every response, so post-install tampering is blocked even before a later startup scan.

## Custom protocol

Only the Rust shell registers:

```text
sovereign-ui://localhost/release/<releaseId>/<signed-component>
```

The handler accepts `GET` and `HEAD` only. It never performs directory fallback and serves only a case-exact path listed in the signed manifest. Requests are additionally bound to the requesting webview: the main webview may read only its persisted active release, while a hidden preflight webview may read only the release named by its live manager ticket. Other installed slots are not executable through URL navigation.

A shell-level navigation policy allows the main and preflight surfaces to navigate only to the renderer `index.html` entrypoint (or the built-in local entrypoint when state permits it). External origins, non-entrypoint HTML documents, malformed activation queries, and cross-surface navigation are denied before page load. HTML receives a restrictive CSP including `frame-ancestors 'none'` and `no-store`; immutable non-HTML assets receive long-lived caching. Every response uses `nosniff`, same-origin resource policy, and no-referrer policy.

A failed size or digest check returns an error and does not serve the modified bytes. Repeated failures are deduplicated and rate-limited before the immutable state journal is extended, preventing a bad page from exhausting journal capacity.

## Hidden preflight

Activation requires a fresh successful preflight. The shell creates a hidden `renderer-preflight-*` WebView2 window for the candidate release and waits at most 20 seconds for a release-bound readiness report.

That window has a separate Tauri capability document. Its bridge reroutes control-plane calls to a native read-only allowlist, and each call must still match a currently live manager-owned preflight ticket for that exact hidden window label. Closing, completing, or timing out the ticket immediately revokes the bridge even if WebView destruction is delayed. It may inspect bounded runtime state, manifests, audits, runs, tasks, capability reports, observations, and terminal reads needed to render existing pages. It cannot:

- install, preflight, activate, or roll back another renderer;
- change settings, workspace, permission profile, Tunnel state, tasks, or runs;
- write files, execute commands, type, click, navigate a browser, or invoke another mutation;
- access raw filesystem paths or Node APIs.

A renderer import/startup exception is reported immediately as a failed preflight instead of being represented as a timeout.

A successful receipt is release-digest-bound and expires after ten minutes. Modifying/reinstalling a slot invalidates the relationship, so activation requires another preflight.

## Activation and UI handoff

Activation is owned by the Rust shell. It:

1. re-verifies the installed slot;
2. requires and consumes a fresh matching preflight receipt;
3. rejects a release sequence that is not greater than the highest sequence ever accepted by the current state journal;
4. appends an immutable, SHA-256-chained state revision that sets the candidate active and promotes the previous active renderer to last-known-good;
5. records a bounded handoff containing only current view, Settings tab, and scroll position;
6. creates a unique 128-bit activation nonce and navigates the existing main webview to the candidate custom-protocol URL;
7. requires the same activation nonce, release ID, bridge API version, nonempty application surface, and no startup error within 20 seconds;
8. removes the one-time nonce from browser history after the native readiness acknowledgement, so an ordinary later page reload is valid but cannot replay an old activation.

The new renderer reads the handoff before importing its main module and restores the view, Settings tab, and scroll position. Runtime-side Tasks, runs, terminals, Gateway sessions, Tunnel state, and audit records remain owned by the Runtime Host and are not restarted.

## Rollback and startup recovery

If activated renderer readiness fails or times out, the shell appends another state revision, restores the previous active/last-known-good reference, navigates back, and preserves the handoff for the fallback renderer. Stale timeout threads and stale readiness messages cannot affect a newer activation because both are nonce-bound. A local **Rollback** action follows the same guarded readiness path, including rollback to the built-in renderer. After a successful manual rollback, the built-in renderer becomes the next conservative fallback rather than retaining the just-rejected release as last-known-good.

Rollback is a managed recovery operation, not a new release installation: it does not acquire a new-candidate lease or require a higher target sequence. Verify the recovered last-known-good or built-in target, completion of its readiness boundary, and the preserved recovery reason; do not clear `lastFailure` to make recovery look like a successful new activation. If recovery follows a failed hot-update attempt, fail that attempt's lease and notify affected Tasks. Keep the historical sequence floor intact.

Shell restarts and native executable updates follow their own authorized recovery/update procedure. They do not require manufacturing a Renderer candidate. A Shell restart during hot activation invalidates the PID-bound transaction; record the interruption and reconcile durable state before any later attempt.

State is stored as contiguous immutable revisions:

```text
renderer-updates/state/revision-00000000000000000001.json
renderer-updates/state/revision-00000000000000000002.json
```

Each revision includes `previousStateSha256` and a monotonic `highestReleaseSequence`. Publication uses an exclusive temporary file, a no-overwrite hard link, and an immediate byte-for-byte re-read of the published revision. Missing revisions, a broken hash chain, malformed or noncanonical nullable fields, an unsafe JSON integer, a cumulative journal larger than 16 MiB, unexpected entries, or an invalid active slot cannot select untrusted code. A corrupt journal is quarantined under `state-corrupt-*`; the shell creates a new journal, raises the sequence floor to the highest verified installed slot, and restores its built-in renderer. With a healthy journal, a merely staged release does not raise the floor and remains eligible for later activation. At startup, an invalid active slot falls back to a valid distinct last-known-good slot or the built-in renderer.

The external release guard uses that same verified journal as its acquisition baseline. When the built-in Renderer is active, the lease records `previousActiveReleaseId: null` and `previousActiveSequence: null`; candidate eligibility still compares against `highestReleaseSequence`, so returning to the built-in Renderer cannot reopen an older release sequence.

Only four corrupt-journal quarantines are retained. The signed slots themselves are not silently deleted by this mechanism.

## Operator status

The Diagnostics panel reports:

```text
whether trusted keys enable updates
stable shell and bridge API version
active renderer or built-in renderer
last-known-good renderer
installed releases
release IDs present in the inbox
release IDs holding an unexpired preflight receipt
highest accepted release sequence
pending activation target and phase
last bounded failure
```

The normal flow is:

```text
Install -> Preflight -> Activate
```

Activation is intentionally separate from installation. Merely copying or installing a candidate cannot make it active.

## Verification

Relevant checks are:

```powershell
pnpm --filter @sovereign/update-core test
pnpm --filter @sovereign/desktop-tauri smoke:renderer-update
pnpm --filter @sovereign/desktop-tauri typecheck
pnpm --filter @sovereign/desktop-tauri build:web
cargo test --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml renderer_update --lib
cargo check --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml
```

The automated coverage includes canonical signature/key verification, required-nullable-field rejection, safe-integer enforcement, tamper rejection, exact-inventory rejection, slot installation, per-webview protocol authorization, navigation-policy enforcement, post-install component tamper blocking, repeated-failure journal protection, activation-nonce binding, monotonic anti-downgrade state, clean-restart staging behavior, corrupt-journal sequence-floor recovery, TypeScript manifest/inventory/compatibility validation, private-key location policy, safe package replacement, and a generated-package signing smoke.

## Current limitations

- There is no network release discovery or downloader.
- Renderer trust is generated into ignored runtime resources; development builds are explicitly disabled, while renderer-enabled release commands require a nonempty validated registry.
- The hidden WebView2 preflight path is compiled and capability-restricted; current automated tests exercise its lower-level signed slot, protocol, bridge, and readiness contracts but do not drive a real Windows hidden webview end to end.
- Renderer updates cannot alter the native command allowlist or bridge API version.
- The legacy Electron shell exposes renderer-update status as disabled and rejects renderer update mutations.
- Tool-pack live reload remains a separate implementation and is not installed, completed, or modified by this work.
- Runtime Host candidate activation and full native shell updates use their separate managed update paths.
