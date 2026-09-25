# Durable cutover journal and crash recovery

Renderer and Runtime Host cutovers are multi-step transactions. A process can stop after a candidate becomes visible but before the final receipt is written, so an in-memory phase enum is not sufficient authority. The layered update implementation now persists three independent sources of evidence:

```text
CutoverLedger
  append-only transition and receipt history

RuntimeRouteRegistry
  append-only authoritative Runtime Host route and fencing token

RendererSlotStore
  immutable renderer slots and generation-numbered active/rollback pointer
```

The recovery inspector combines them. It never infers authority from the last log line alone.

## Cutover ledger

`packages/update-core/src/cutover-ledger.ts` stores canonical, bounded records under:

```text
<root>/entries/
  00000000000000000001-<digest-prefix>.json
  00000000000000000002-<digest-prefix>.json
```

Each record contains:

```text
sequence
previousEntrySha256
recordedAt
kind = runtime | renderer
recordType = transition | receipt
cutover identity
phase or outcome
active/candidate release identity
Runtime instance/checkpoint identity or renderer generation
bounded failure and cleanup evidence
entrySha256
```

Properties enforced by the reader and writer:

- exact schema; unknown fields fail closed;
- contiguous global sequence;
- SHA-256 hash chain;
- filename bound to sequence and payload digest;
- private regular files only, with no symlink or extra hard-link;
- bounded file size and entry count;
- one immutable cutover identity across all records;
- no records after a receipt;
- Runtime instance identity cannot change mid-cutover;
- renderer generation cannot move backwards;
- cross-process append lock with bounded wait and conservative stale-lock recovery.

A transition is written before its consequential phase. Cleanup phases still execute if their ledger write fails, because restoring the previous authority has priority; the final caller receives a durable-recording error containing the actual cutover receipt.

## Runtime route registry

`packages/update-core/src/runtime-route.ts` persists the Runtime Host authority as a second append-only hash chain. It records an opaque local route ID rather than a raw socket or command line:

```text
active {
  instanceId
  releaseId
  routeId
  checkpointId
  fencingToken
}
previous | null
generation
operation = bootstrap | switch | rollback | commit
```

Every mutation is compare-and-swap against `expectedGeneration` and cross-process serialized. A forward switch must use a new instance ID, route ID, and fencing token. Rollback must exactly invert the previous switch. Commit may clear the previous route only without changing the active route.

The persisted route does not itself open a network listener. The desktop Runtime Host adapter maps the opaque route ID to an already authenticated private control channel and applies the selected revision to the in-memory traffic router.

## Durable Runtime Host coordinator

`packages/update-core/src/durable-runtime-cutover.ts` composes:

- `RuntimeCutoverCoordinator`;
- `CutoverLedger`;
- `RuntimeRouteRegistry`;
- a platform adapter that can start/health-check/quiesce/drain/checkpoint/canary/stop a Runtime Host and apply an authoritative route revision.

Before a cutover starts, the route registry must match the declared active instance and generation. Each phase is durably logged before its adapter side effect. The forward route transaction is:

```text
describe candidate private route
  -> append route switch revision
  -> apply route revision to traffic router
```

If route application fails, the registry is rolled back and the previous route is applied before the phase error is returned. A canary or commit failure follows the normal coordinator rollback, resumes the previous host, and stops the candidate. Successful candidate commit clears the previous route; failure merely to stop a now-non-authoritative old host is retained as cleanup evidence.

## Durable renderer coordinator

`packages/update-core/src/durable-renderer-cutover.ts` performs the renderer transaction directly over `RendererSlotStore` and `CutoverLedger`:

```text
verify candidate and rollback slot
  -> durable preflight phase
  -> capture bounded JSON state
  -> durable activation phase
  -> generation-CAS pointer activation
  -> reload / ready / restore / observe
  -> terminal transition and receipt
```

After pointer activation, any failure appends cleanup phases, swaps the pointer back, reloads and checks the previous renderer, and restores the same bounded state. A rollback failure produces a `failed` outcome rather than a false success.

The state handoff is intentionally bounded JSON. It may contain route, selected task, focus, scroll, and unsent UI draft state. It must not become the authority for Tasks, messages, approvals, Runs, terminals, artifacts, or permissions; those remain in Runtime Host persistence.

## Renderer handoff vault

`packages/update-core/src/renderer-handoff.ts` provides the bounded one-time UI handoff used around a renderer navigation. It is release- and generation-bound, expires after at most five minutes, and carries only an explicit state schema:

```text
view ID
Settings tab
selected Task and Run IDs
focus key
bounded scroll positions
bounded unsent UI drafts
```

The envelope includes a random handoff ID and SHA-256 of canonical state. Consumption removes the storage record before parsing, so a malformed, expired, tampered, or wrong-target handoff cannot be retried or replayed. Duplicate state keys, control characters, oversized drafts, unknown fields, and an excessive envelope are rejected.

The vault accepts an abstract storage interface. A desktop adapter may bind it to a same-origin session store or a shell-owned volatile map. It must not use persistent cloud storage and must not place authoritative Task, Run, permission, terminal, or credential state in the handoff.

## Recovery inspection

`packages/update-core/src/cutover-recovery.ts` first asks the ledger for cutovers without receipts, then checks actual authority:

- Runtime cutovers are compared with the current route revision.
- Renderer cutovers are compared with the current slot pointer.

Examples:

```text
ledger: candidate-canary
route:  candidate active, old route retained
result: rollback traffic, resume old host, stop candidate (safe to automate)

ledger: candidate-canary
route:  old host already active, candidate retained as previous
result: resume old host and stop candidate (safe to automate)

ledger: commit-candidate
route:  committed candidate active, no previous route
result: finish old-host cleanup (safe to automate)

ledger: candidate-ready
renderer pointer: candidate active, old renderer retained
result: rollback renderer (safe to automate)

ledger: committed, no receipt
result: verify terminal state (not auto-accepted)
```

A mismatched or unrelated authority returns `manual-intervention`. The inspector never blindly toggles a route or renderer pointer merely because a phase name contains “rollback”.

## Automated recovery executor

`packages/update-core/src/cutover-recovery-executor.ts` executes only recovery plans that the inspector marks safe against current authority. It re-reads the ledger and refuses to act when a Runtime candidate instance is missing, a route is uninitialized, a renderer pointer is absent, or the current authority no longer matches the planned rollback target.

Runtime recovery supports:

```text
stop an unhealthy pre-switch candidate
resume the old active host and stop the candidate
rollback the authoritative route, apply it, resume old host, stop candidate
verify a committed candidate route and finish retiring the previous host
```

Renderer recovery supports:

```text
close a pre-activation interruption without pointer changes
rollback a candidate pointer, reload previous slot, wait for readiness
finish a pointer rollback that was persisted before the previous UI reloaded
```

Every consequential recovery phase is appended to the existing cutover ledger before its side effect. A successful recovery writes a normal terminal cutover receipt so the interruption no longer appears in recovery inspection. A terminal transition without a receipt remains non-automatic, and an unknown candidate process ID is not guessed from process listings.

Recovery adapter operations are bounded by deadlines. A timeout or adapter failure leaves the cutover open for another evidence-based inspection rather than writing a false successful receipt.

## Platform adapter requirements

The remaining desktop integration must implement the platform adapters without weakening these invariants.

Runtime Host adapter:

- candidate starts with a private, non-authoritative control channel;
- health includes protocol, manifest, database-read, permission, and workspace-boundary checks;
- quiescence rejects new consequential calls;
- drain reports `inFlight = 0` and `unknown = 0` before switch;
- checkpoint persists Task state and returns a fresh fencing token;
- route application is atomic from the router’s perspective;
- post-switch writes verify the current fencing token;
- canary uses authenticated read and bounded write/idempotency probes;
- stop is idempotent and Guardian-compatible.

Renderer adapter:

- hidden candidate webview loads only the verified immutable slot;
- bridge protocol range is checked before activation;
- capture and restore are bounded and do not include secrets;
- ready includes a candidate nonce/generation;
- observation covers startup errors and a bounded interaction smoke;
- rollback can always reload the retained previous slot.

## Verification coverage

The focused tests cover:

- ledger chaining, tampering, malformed files, cross-process append, stale-lock handling, identity drift, and records after receipt;
- recovery recommendations at every consequential Runtime and renderer phase;
- route bootstrap, switch, rollback, commit, CAS loss, fencing reuse, cross-instance serialization, and tamper detection;
- durable Runtime success, canary rollback, route-apply rollback, stale authority rejection, and cleanup logging;
- durable renderer success, bounded state, preflight rejection, pointer rollback, previous-renderer failure, and stale generation rejection;
- authority-aware crash-recovery refinement and manual-intervention cases.
