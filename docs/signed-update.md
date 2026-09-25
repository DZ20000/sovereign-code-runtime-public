# Signed side-by-side update contract

## Status

This document defines Sovereign's future signed A/B update boundary. The current product does **not** automatically replace its installed or portable executable.

Implemented checkpoints are intentionally limited to:

```text
release-manifest validation
Ed25519 public-key verification
component/path/inventory verification
schema/rollback compatibility checks
pure deterministic update state machine
cleanup retention planning
immutable bootstrap state revisions with guarded compare-and-swap publication
verified stream-to-slot candidate materialization with final ready-marker publication
isolated packaged candidate preflight with bounded identity/process/UI evidence
```

The implemented packages persist reducer state, materialize an already supplied signed candidate into a new side-by-side slot, and can launch that verified slot only as an isolated packaged preflight. They do not download a release, parse an archive, activate a slot, roll back a live release, mutate the active bootstrap pointer, run a remote canary, or delete installed releases.

Renderer-only bundle activation is implemented separately in the stable Tauri/Rust shell. It uses its own narrower manifest, immutable slots, custom protocol, hidden read-only preflight, and UI-readiness rollback without replacing executable components. See [`renderer-hot-updates.md`](renderer-hot-updates.md). That mechanism does not weaken or substitute for the full-release bootstrap boundary described below.
## Trust boundary

The update signing private key must never exist:

- on a target Sovereign host;
- in an authorized workspace;
- in application user data;
- in a package artifact;
- in an environment variable visible to Sovereign;
- in a CI artifact delivered to the target;
- in an MCP tool response or audit detail.

The target contains only a bounded registry of Ed25519 **public** keys. Every entry has a unique key ID, an allowed release-sequence interval, and an allowed channel set. Verification rejects PEM values containing private-key material, multiple keys, comments, or non-canonical SPKI content even if Node could otherwise derive a usable public key.

A stable bootstrap/updater is outside all candidate release directories. A candidate cannot validate itself, choose its own trusted key, or make the final rollback decision.

## Side-by-side slots

```text
updates/
  bootstrap-state/
    revision-0000000000000001.json
    revision-0000000000000002.json
    .bootstrap-update-state-<pid>-<uuid>.tmp
  slots/
    release-<id>/
      .scr-update/
        envelope.json
        ready.json
        .slot-ready-<pid>-<uuid>.tmp
      SovereignCodeRuntime.exe
      node/node.exe
      runtime-host.cjs
      host-guardian.mjs
      runtime-manifest.json
      native/bin/SovereignNativeAgent.exe
```

The live entry point must resolve through bootstrap-controlled state, not by overwriting the currently running executable.

At all times retain:

```text
current active release
last-known-good release
candidate release while staged/preflight/canary is incomplete
```

Cleanup may remove only releases outside that retained set. It must never remove the sole verified rollback release.

## Bootstrap state storage

The implemented state-store schema is `scr.bootstrap-update-state/v1`. It uses immutable, contiguous revision files rather than overwriting one mutable JSON document.

Each revision contains:

```text
storageRevision
previousStateSha256
strictly parsed scr.update-state/v1 payload
```

Publication is guarded as follows:

1. require an absolute local state directory under an existing real parent;
2. reject parent/state directories, revisions, or temporary entries that are symbolic links or junctions;
3. read and validate the complete bounded revision chain from revision one;
4. compare both the caller's expected storage revision and expected SHA-256 with the current head;
5. write a unique same-directory temporary file with exclusive creation;
6. flush the temporary file;
7. publish the deterministic next revision by a no-overwrite hard link;
8. best-effort flush the state directory and report whether that metadata flush was supported;
9. re-read and verify the published revision before returning it.

Two writers using one expected head can therefore publish only one deterministic next filename. The loser receives a conflict rather than overwriting the winner. A crash before publication leaves only an ignored, bounded temporary file. A crash after publication leaves a complete immutable revision even if temporary-file cleanup did not run.

The store fails closed for gaps, broken SHA chains, malformed or oversized state, unexpected directory entries, excessive revision/temporary counts, stale compare-and-swap expectations, and release-state schema violations. It also bounds cumulative chain bytes so an attacker cannot force unbounded historical parsing.

On platforms where opening and flushing a directory is unsupported, the write result reports `directorySyncCompleted: false`. Future stable native bootstrap integration must decide whether to block activation or provide an OS-native directory metadata flush; the current package does not silently claim that stronger durability.

## Release manifest

The signed manifest schema is `scr.release/v1`.

Required identity:

```text
releaseId
releaseSequence
version
channel
createdAt
entrypoint
totalBytes
components
compatibility
```

`releaseSequence` is the monotonic update ordering value. Human-readable `version` is not sufficient for rollback prevention. `releaseId` is the side-by-side slot identity and must be a distinct lowercase identifier that does not collide with active or last-known-good storage.

Each component declares:

```text
relative path
SHA-256
byte length
role
```

The payload inventory must exactly match the manifest: no missing component, changed hash/size, duplicate case-insensitive path, or unmanifested payload file.

## Path rules

Manifest component paths are portable forward-slash relative paths. Reject:

- empty, absolute, drive, UNC or device paths;
- backslashes;
- `.` or `..` segments;
- empty segments or doubled separators;
- colon, NUL or control characters;
- trailing dot or space in a segment;
- Windows reserved device names;
- characters outside the bounded package alphabet;
- case-insensitive duplicates;
- `.scr-update` as a component root because it is reserved for bootstrap metadata;
- a component path that is also the directory prefix of another component.

Resolving a component under a candidate slot proves lexical containment. The implemented destination materializer and inspector reject symbolic links, junctions, hard links, non-regular entries, path-casing mismatches, unexpected files/directories, and file identity or timestamp changes observed while a verification handle is open. A concrete filesystem/archive source adapter and the eventual process launcher must still use OS-native no-reparse opens and reject alternate data streams or equivalent platform-specific aliasing before those boundaries are considered production activation authorities.

## Candidate slot materialization

The implemented materializer consumes a verified logical component source. It deliberately does not accept an archive filename or an arbitrary source-directory path. The stable bootstrap adapter is responsible for exposing only exact manifest-relative component names and byte streams. A future filesystem-backed adapter must open every source component without following reparse points; an archive-backed adapter must reject duplicate, absolute, traversal, link, device, sparse-abuse, and unmanifested entries before presenting the logical source interface.

Materialization order:

1. verify the complete signed envelope and trusted-key policy before creating a slot;
2. require the source inventory to exactly match signed component paths, including casing;
3. exclusively create the final `releaseId` directory and never overwrite or resume an existing slot;
4. write the canonical verified envelope under the reserved `.scr-update` directory;
5. stream each component with bounded chunk size/count and optional cancellation;
6. enforce signed byte length and SHA-256 while writing each exclusively created file;
7. flush component files and best-effort flush all created parent directories;
8. write a unique temporary ready marker;
9. publish `.scr-update/ready.json` with a no-overwrite hard link only after every component is complete;
10. re-open the slot, re-verify the envelope/signature, enforce the exact directory inventory, and re-hash every component before returning.

A failed or cancelled write leaves an incomplete slot without `ready.json`; inspection reports it as not ready. A second writer cannot overwrite the slot, and a failed exclusive open never deletes a file created by another writer. Orphaned ready-marker temporary files are tolerated but do not authorize launch.

`ready.json` is only a completion marker, not activation authorization. The implemented preflight performs full slot inspection twice, compares the signed identity, and resolves one contained unshared regular-file entrypoint immediately before launch. A future stable cutover must additionally bind that identity to the persisted update generation and use native no-reparse handles for process creation. The inspection result reports `directorySyncCompleted`; a stable bootstrap must refuse activation or provide a stronger native metadata flush when that value is false. Preflight launch is verification-only and never changes the active release.

## Signature envelope

Envelope schema: `scr.release-signature/v1`.

```text
algorithm: ed25519
keyId
manifestSha256
signature
manifest
```

The digest is lowercase SHA-256 over canonical JSON of the manifest. The Ed25519 signature covers a domain-separated payload containing that digest.

Verification order:

1. require the signed-envelope schema before interpreting an unsigned object;
2. reject missing or unknown envelope, manifest, component, and compatibility fields;
3. validate manifest schema, canonical timestamp/version forms, and paths;
4. recompute the ordinal-key canonical manifest digest;
5. compare the declared digest;
6. validate the bounded trusted-key registry and resolve one unique `keyId`;
7. enforce that key's release-sequence interval and channel policy;
8. reject private-key or non-canonical/multi-key PEM material;
9. verify the Ed25519 signature.

An unknown or duplicate key, retired/out-of-range key, disallowed channel, altered manifest, malformed signature, unsigned semantic field, or private key fails closed.

## Compatibility and rollback safety

Before cutover, the candidate must be compatible with the stable bootstrap and current data schemas.

Manifest compatibility declares:

```text
minimum / maximum bootstrap version
private Runtime Host protocol version
settings readable range + write version
audit readable range + write version
runs readable range + write version
pre-commit data policy
```

Initial accepted pre-commit policy:

```text
backward-compatible
```

For each data store:

- candidate readable range must include the current on-disk schema;
- candidate write version must be inside its own readable range;
- last-known-good readable range must include the candidate write version.

This preserves rollback after candidate canary. A future irreversible migration requires a separate committed migration protocol and cannot be smuggled into an ordinary candidate update.

The private shell/Runtime Host protocol version must match exactly. The current bootstrap version must fall inside the candidate's declared bootstrap range.

## Preflight and canary

Candidate preflight runs side-by-side with:

- isolated user data;
- no live Tunnel ownership;
- no live Windows login-start mutation;
- no update-state mutation outside the bootstrap protocol;
- bounded startup and report deadline;
- verified component inventory.

Required preflight evidence:

```text
shell starts
Runtime Host starts
Gateway starts on loopback
manifest/tool catalog loads
Host Guardian starts
candidate reports its release identity
candidate reports schema/protocol compatibility
all preflight processes exit cleanly
```

Preflight failure or timeout discards the candidate while the active release remains unchanged.

The implemented `runCandidatePreflight` boundary:

1. verifies the ready slot, signature, exact inventory, and hashes;
2. creates a fresh isolated profile, AppData, LocalAppData, temporary directory, workspace, WebView2 directory, and Runtime Host user-data root;
3. passes only a small OS environment allowlist plus explicit preflight variables—never live Tunnel, proxy, connection, workspace, or provider credentials;
4. launches the signed entrypoint with a bounded timeout and cancellation path;
5. requires a bounded unshared `scr.tauri-smoke/v1` report;
6. binds the report to release ID, release sequence, manifest SHA-256, exact executable path, Runtime Host protocol, and release version;
7. requires loopback Gateway readiness, loaded tools, shell/Runtime Host/Host Guardian processes, real memory and host-availability observations, a ready local UI, and no Tunnel ownership;
8. returns only bounded checks plus the report digest/size, then removes the isolated artifacts unless explicitly retained for diagnostics.

The packaged Tauri shell emits `scr.update-preflight-evidence/v1` only when all four preflight environment values are present and canonical. Malformed or partial metadata makes the smoke report fail. Host Guardian is enabled for this isolated mode and is included explicitly in resource snapshots, while tray ownership, single-instance ownership, live login startup, and live Tunnel configuration remain outside the preflight profile.

Cutover requires a bootstrap-owned lease and no consequential request or other update operation in flight. During canary:

- candidate is active;
- old active release remains last-known-good and is not deleted;
- remote canary has a bounded deadline;
- candidate crash, missed deadline or negative canary triggers rollback;
- late events from an older update generation are ignored;
- same-generation success reported at or after the applicable preflight, cutover, or canary deadline is rejected rather than racing the timeout path.

A canary pass commits the candidate as active while retaining the prior active release as last-known-good.

## Crash recovery

Bootstrap state is persisted before each externally visible effect. On startup:

- interrupted `preflight` returns to active release and discards candidate;
- interrupted `cutover` or `canary` activates last-known-good;
- interrupted `rollback` continues activating last-known-good;
- a rollback completion must identify the expected last-known-good release ID;
- failure to activate last-known-good enters `needs-attention` with bounded redacted evidence;
- an observed active slot inconsistent with persisted state fails closed to rollback/attention;
- `idle` never silently trusts an unknown active slot.

Candidate code does not decide this recovery path.

## Pure state machine

Lifecycle:

```text
idle
staged
preflight
ready-to-cutover
cutover
canary
rollback
needs-attention
```

Events are generation-bound and timestamped with process-monotonic time. Persisted timestamps are never compared across bootstrap processes: recovery first refreshes the local monotonic epoch or moves the interrupted lifecycle into discard/rollback before accepting ordinary events.

Effects are declarative:

```text
launch isolated preflight
discard candidate
activate candidate
start remote canary
activate last-known-good
commit candidate
require attention
ignore stale event
hold
```

The reducer performs no filesystem, process, registry, network, DPAPI or signature operation.

## Minimum deterministic tests

```text
unsigned envelope rejected
unknown or duplicate signing key rejected
private, multi-key, or non-canonical public-key PEM rejected
disallowed signing-key channel rejected
unknown signed fields rejected
bad manifest digest rejected
bad or non-canonical signature rejected
path traversal rejected
absolute/drive/UNC path rejected
case-insensitive duplicate path rejected
candidate component cannot resolve outside slot
missing/extra/hash/size inventory mismatch rejected
bootstrap incompatibility blocks candidate
current data schema outside candidate readable range blocks candidate
candidate write schema unreadable by last-known-good blocks cutover
preflight timeout leaves current active and discards candidate
late preflight/cutover/canary success is rejected
candidate crash during canary activates last-known-good
current and last-known-good retained throughout canary
candidate release ID cannot collide with a retained slot
late generation or phase-regressing event ignored
interrupted cutover recovers to last-known-good
rollback completion must identify last-known-good
rollback activation failure enters needs-attention
canary pass commits candidate but retains prior active as last-known-good
cleanup keeps current + last-known-good + in-progress candidate
release sequence downgrade rejected
bootstrap state create/read round-trip
stale state SHA/revision compare-and-swap rejected
concurrent state writers publish only one next revision
orphaned temporary state file leaves current revision readable
revision gap, broken chain, malformed JSON, oversized chain, or unexpected entry rejected
state directory, parent, or revision symlink/junction rejected
interrupted reducer state is recovered and persisted as a new immutable revision
reserved slot metadata path and file/directory component conflicts rejected
source inventory mismatch rejected before slot creation
untrusted envelope rejected before slot creation
component length/hash/chunk/cancellation failure leaves no ready marker
concurrent materializers create only one release slot
exclusive-write conflict does not delete another writer's file
ready slot reinspection detects envelope/component tampering and unexpected entries
component symlink, junction, or external hard link rejected
missing metadata or ready marker remains non-launchable
directory durability capability is reported rather than assumed
preflight report missing, oversized, multiply linked, malformed, or identity-mismatched is rejected
preflight protocol/version/entrypoint mismatch is rejected
preflight rejects live Tunnel ownership and a missing Host Guardian
preflight timeout/cancellation kills the process tree and leaves no isolated artifacts
packaged preflight proves shell + Runtime Host + loopback Gateway + UI + Host Guardian readiness
```

## Deferred process implementation

After the implemented manifest, immutable state-store, slot materialization, and isolated packaged-preflight checkpoints pass all existing product gates:

1. harden production launch/cutover with native no-reparse process handles and a stronger directory-durability primitive where required;
2. add authenticated release acquisition and archive/source adapters outside the logical component-source boundary;
3. add bootstrap-controlled cutover and rollback effect execution;
4. add remote canary evidence;
5. add release-slot and historical state-revision cleanup policy;
6. add signed release creation in an external build environment.

The signing tool and private key remain outside the target application repository/runtime boundary.
