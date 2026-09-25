# Signed Runtime Host candidates

Sovereign can install and activate a reviewed Runtime Host bundle without accepting a filesystem path, hash, signature, checkpoint, or generation from the Renderer. The public desktop API accepts only a bounded `releaseId`; the Rust shell resolves every other value from its managed, signed state.

## Public desktop API

```text
getRuntimeCandidateUpdateStatus()
installRuntimeCandidateUpdate(releaseId)
activateRuntimeCandidateUpdate(releaseId)
```

The installed Tauri shell exposes the same bounded surface in **Settings → Diagnostics → Runtime Host candidates**. The view shows only active, installed, and inbox release IDs plus trust count and bounded failure fingerprints. Install and Activate are explicit operator actions. Electron keeps this feature unavailable, and renderer-preflight windows reject all candidate commands.

The public status reports only:

- whether trusted signing keys are provisioned;
- whether an install or activation is in progress;
- trusted-key count;
- highest accepted release sequence;
- active release ID;
- installed and inbox release IDs;
- a bounded failure fingerprint.

It never returns slot roots, component paths, SHA-256 values, signing keys, signatures, checkpoint IDs, internal instance IDs, generation fences, connection credentials, or authorization headers.

## Managed layout

The default root is the desktop application-data directory:

```text
runtime-updates/
  state.json
  inbox/
    <releaseId>/
      envelope.json
      runtime-host.cjs
  slots/
    <releaseId>/
      envelope.json
      runtime-host.cjs
  quarantine/
    stale-stage-<nonce>/
    failed-stage-<nonce>/
    uncommitted-slot-<nonce>/
```

`SCR_RUNTIME_CANDIDATE_UPDATE_ROOT` and `SCR_RUNTIME_CANDIDATE_TRUSTED_KEYS_PATH` exist for controlled test and operator environments. They are shell-process configuration, not tool or Renderer parameters.

An inbox package must contain exactly `envelope.json` and `runtime-host.cjs`. Additional files, directories, symbolic links, junctions, reparse points, alternate package layouts, and paths that escape the managed root are rejected.

## Signed envelope

The envelope schema is:

```text
scr.runtime-candidate-release-signature/v1
```

It contains:

```text
algorithm: ed25519
keyId
manifestSha256
manifest
signature
```

The manifest schema is:

```text
scr.runtime-candidate-manifest/v1
```

The manifest binds:

- release ID;
- monotonically increasing release sequence;
- creation timestamp;
- minimum signed shell version;
- Runtime control protocol version;
- exact `runtime-host.cjs` relative path;
- exact byte length;
- exact SHA-256.

The Ed25519 signature covers a domain-separated payload:

```text
scr.runtime-candidate-signature/v1
<canonical manifest SHA-256>
```

JSON is canonicalized before hashing. Signature bytes must use canonical unpadded base64url. Trusted public keys use canonical Ed25519 SPKI PEM and can restrict the minimum and maximum release sequence they authorize.

Runtime candidates use a separate trusted-key resource:

```text
runtime-candidate-trusted-keys.json
```

The repository registry is intentionally empty and `runtime-candidate-trusted-keys.json` is not included in the default Tauri resource list. Production release engineering must provision a reviewed registry in the signed shell, or a controlled operator/test environment may point `SCR_RUNTIME_CANDIDATE_TRUSTED_KEYS_PATH` at one. A missing registry resolves to zero trusted keys and keeps status, installation, activation, and rolling cutover disabled rather than inventing trust.

## Installation

Installation performs all checks before publication:

1. validate the bounded release ID;
2. acquire the single-flight transition guard;
3. verify strict inbox inventory;
4. parse and validate the envelope and manifest;
5. enforce signing-key trust and sequence window;
6. enforce minimum shell and exact Runtime protocol compatibility;
7. stream and verify component size and SHA-256;
8. reject release-sequence rollback;
9. copy into a private staging directory;
10. persist and reread the canonical envelope;
11. reverify the staged package;
12. rename the staging directory into the immutable managed slot;
13. atomically update `state.json` with backup recovery.

A repeated installation of the same release ID is idempotent only when its signed manifest is identical and the installed slot still reverifies. Reusing a release ID with different signed content fails closed.

The reviewed package producer is `apps/desktop-tauri/scripts/create-runtime-candidate.mjs`. Both its CLI parser and exported programmatic function validate a closed option set, bounded identifiers and strings, positive safe-integer sequences/timestamps, direct regular Runtime/key files, Ed25519 PKCS#8 key type, exact staged digest, and a non-existing output path before publication. The output may not be a filesystem root or a direct child of one, and temporary cleanup accepts only the producer-owned random staging directory beside the requested output.

## Activation

Activation and installation share the same atomic single-flight guard. Activation performs:

```text
releaseId
→ reverify managed slot signature/inventory/hash
→ pass internal slot root and SHA-256 to RuntimeHostSupervisor
→ start passive candidate
→ candidate preflight
→ live Runtime quiesce and drain
→ endpoint cutover and managed-session rebinding
→ inspect internal cutover receipt
→ mark release active only after committed outcome
```

The internal Supervisor receipt is never returned directly. The manager requires:

- outcome `committed`;
- candidate release ID equal to the requested release;
- no failure reason.

After candidate canary succeeds, writing and flushing `activeReleaseId` is the commit callback for native ownership publication. The supervisor swaps its active process pointer and stops the previous Runtime Host only after that durable callback succeeds. If the callback fails, it first confirms the promoted candidate stopped and then resumes the previous Runtime Host. An unconfirmed promoted-candidate shutdown or authority resume is classified as restart-required instead of allowing two owners to continue.

A rolled-back, failed, mismatched, or durably uncommitted cutover leaves the previously active release unchanged and stores only a bounded error fingerprint.

The public activation receipt contains only:

```text
releaseId
releaseSequence
outcome: activated
activatedAtUnixMs
receiptId
```

## Rolling-status integration

`runtime_rolling_status` no longer permanently reports that no signed candidate launcher exists. The status command updates Supervisor availability from the trusted candidate manager:

```text
trusted keys loaded → rolling candidate launcher enabled
no trusted keys     → disabled with explicit reason
```

This does not mean a release is automatically installed or activated. The operator or reviewed automation must still select an inbox `releaseId`, install it, and explicitly activate it.

## Read-only managed-state audit

The shell-owned candidate state can be checked without installing, activating, restarting, or changing Runtime authority:

```powershell
pnpm --filter @sovereign/desktop-tauri runtime:candidate:audit -- `
  --managed-root <runtime-update-root> `
  --runtime-trust <shell-owned-runtime-candidate-trust.json> `
  --shell-version <signed-shell-version> `
  --runtime-protocol-version 1
```

The audit treats an absent `state.json` as the pristine pre-install state only when no backup or installed slot exists; otherwise it requires `state.json` to remain canonical and internally valid, requires the `slots/` inventory to match the installed state exactly, reverifies every installed slot against the current trusted Runtime signing registry, and compares any same-release inbox package with the installed slot identity. Missing or orphaned slots, active-release drift, slot tampering, incompatible package metadata, and inbox-to-slot identity drift fail closed. A stale `state.json.backup` is reported but does not modify or repair state. The audit also refuses to run while a release-index import lock exists so it does not certify a transient import.

For normal update work, run both managed audits through the unified read-only gate:

```powershell
pnpm --filter @sovereign/desktop-tauri runtime:update:preflight -- `
  --managed-root <runtime-update-root> `
  --runtime-trust <shell-owned-runtime-candidate-trust.json> `
  --shell-version <signed-shell-version> `
  --runtime-protocol-version 1
```

Before a specific install or activation, bind the same audit to the intended operation and release identity:

```powershell
pnpm --filter @sovereign/desktop-tauri runtime:update:preflight -- `
  --managed-root <runtime-update-root> `
  --runtime-trust <shell-owned-runtime-candidate-trust.json> `
  --shell-version <signed-shell-version> `
  --runtime-protocol-version 1 `
  --operation <install-or-activate> `
  --release-id <target-release-id>
```

Omit `--operation` and `--release-id` for a general read-only audit. A target-bound result requires both `consistent: true` and `ready: true`.

After an installation or activation reaches a stable outcome, use audit mode again: either omit both flags or specify `--operation audit` without `--release-id`. Require `consistent: true`, `ready: true`, `operation: "audit"`, and `releaseId: null`. For installation, also require the target in `candidate.installedReleaseIds`; for activation, require `candidate.activeReleaseId` to equal the target. Record the operation receipt and audit result. Repeating the pre-operation `install` or `activate` check is not a completion check: it deliberately rejects an already installed or active target.

The unified preflight first validates the release-index receipt/inbox chain, then validates candidate `state.json`, slots, and inbox identity. Target-bound mode additionally requires the selected release to be present in both verified inbox inventories and to be in the correct installed/active state for the requested operation. Any failed sub-audit aborts the preflight. Passing it does not install, activate, restart, change trust, or otherwise mutate Runtime authority. The Tauri owner independently repeats the managed verification while holding the Runtime Candidate transition guard, repeats it before publishing a slot, and repeats it before committing an activation cutover; operator evidence therefore cannot be used as a time-of-check/time-of-use bypass. Managed-preflight failures are preserved as evidence: command error recording does not rewrite candidate state, and startup restore aborts instead of clearing the recorded active release.

## Failure and recovery behavior

- Invalid signatures, hashes, package inventory, key windows, protocol versions, or release sequences fail before slot publication.
- A state update failure restores the complete previous in-memory state and moves the newly published but uncommitted slot into the managed quarantine by same-volume rename.
- Startup validates both the primary state and any backup before deciding which one is authoritative; a corrupt primary can be quarantined only when the backup itself fully validates. Once a new primary has been published, failure to remove a stale backup does not retroactively turn the durable commit into an error.
- Interrupted `.stage-*` directories are moved into the managed quarantine before inventory validation. Other orphaned or missing installed-slot directories still stop candidate-manager initialization.
- Slot tampering is detected again immediately before activation.
- After a committed activation, the next shell startup reverifies the recorded active slot and restores it through the same live cutover path. A recoverable restore failure clears candidate authority, records only a redacted `RUNTIME_CANDIDATE_STARTUP_RECOVERY` fingerprint, and continues with the already-running built-in Runtime Host. If candidate shutdown or previous-authority recovery cannot be confirmed, startup fails closed and requires a Guardian-controlled restart instead of risking two Runtime owners.
- Candidate preflight and cutover retain the existing generation fences, endpoint compare-and-swap, managed-session rebind, and rollback behavior.
- Activation failure text is hashed before it enters public status.
- The manager never accepts a raw executable path or arbitrary command.

External ChatGPT sessions remain outside the desktop-managed session registry. Runtime cutover can report that an external refresh is required, but Sovereign does not claim it can replace ChatGPT's opaque Action approval cache or transport from the server side.

## Current boundary

This feature activates signed Runtime Host JavaScript bundles. It does not perform in-process hot replacement of Tauri, Rust, Node, preload, Native Agent, or DLL components. Those components continue to use signed installation, controlled restart, state preservation, and Guardian recovery.

The signed candidate manager also does not automatically download releases from the network and this checkpoint has no arbitrary file-picker import. A separate governed updater or operator procedure must place an exact two-file package into the managed inbox. Arbitrary URLs, raw paths supplied by the Renderer, and arbitrary module execution are not accepted by this API.

Passing preflight does not authorize a cutover. Run the managed preflight with `--operation <install-or-activate>` and `--release-id <target-release-id>`, then obtain the separate release authorization required by the installation or activation procedure.

## Verification

Automated coverage includes:

- canonical Ed25519 public-key parsing;
- valid signed package installation and idempotent reinstall;
- invalid signature rejection;
- strict package-inventory rejection;
- release-sequence rollback rejection;
- slot tamper detection before activation;
- install/activation single-flight behavior;
- committed cutover receipt validation;
- rolled-back cutover leaving `activeReleaseId` unchanged;
- validated primary/backup state recovery, stale-stage quarantine, filesystem-root rejection, and exact slot-inventory enforcement;
- startup restoration of a reverified active slot and safe built-in fallback when restoration fails;
- programmatic package-producer option validation, direct-file enforcement, filesystem-root output rejection, and Ed25519-only signing;
- public status and receipts excluding paths, hashes, keys, signatures, checkpoints, generations, and credentials;
- Tauri/TypeScript command boundaries accepting only `releaseId`;
- an empty or missing default trust registry keeping installation, activation, and rolling cutover disabled.
