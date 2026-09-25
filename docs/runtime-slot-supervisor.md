# Persistent Runtime slot supervisor

Sovereign's signed update layer already verifies immutable candidate slots before activation. The Runtime slot supervisor adds the durable control-plane state needed to recover an interrupted Runtime Host transition without treating an incomplete candidate as active or silently reusing an old generation.

## Scope

This layer provides three primitives:

1. a strict Runtime transition state machine and deterministic recovery planner;
2. an append-only SHA-256-chained supervisor ledger with revision/hash compare-and-swap;
3. a managed-session registry that can rebind desktop-owned MCP clients and report external clients that require an explicit refresh.

It does not change task inbox, task messages, task acknowledgements, or heartbeat semantics. The `tasks.*` control plane remains outside the workload transition implemented in the next integration layer.

## Runtime identities

Every active, previous, or candidate Runtime is represented by a bounded identity:

```text
releaseId
releaseSequence
version
instanceId
runtimeGeneration
loopback /mcp endpoint
manifestDigest
processId
startedAt
```

The parser rejects unknown fields, malformed identifiers, non-loopback endpoints, URL credentials, queries, fragments, invalid SHA-256 values, invalid process IDs, and invalid timestamps. An observed process may advance the persisted generation for the same release and instance, but it may not reuse an instance ID for another release or manifest.

## Persistent state machine

The supervisor state schema is:

```text
scr.runtime-supervisor-state/v1
```

Supported phases are:

```text
stable
candidate-starting
candidate-ready
quiescing
publishing
candidate-active
rolling-back
needs-attention
```

A new candidate transition increments the supervisor epoch and binds every later event to both:

```text
expectedEpoch
transitionId
```

Stale writers and out-of-order events fail before state publication. Candidate publication atomically moves the former active Runtime to `previous`; commit removes the transition ID but retains the previous identity as a possible rollback source. A rollback must restore the same signed release at a newer Runtime generation.

`needs-attention` may be entered without an active transition when the persisted stable Runtime is unavailable after supervisor restart. It records only a symbolic failure code and SHA-256 digest, never raw process output or connection credentials.

## Append-only ledger

The durable ledger stores immutable entries beneath:

```text
<supervisor-root>/entries/
  entry-0000000000000001.json
  entry-0000000000000002.json
  ...
```

Each entry contains:

```text
schemaVersion
revision
previousEntrySha256
state
```

Publication uses:

1. an exclusive, mode-restricted pending file;
2. file flush;
3. an atomic hard-link publication to the next revision name;
4. pending-file removal;
5. optional directory flush;
6. complete chain reload and verification.

Append requires the current revision and entry SHA-256. This is a two-field compare-and-swap fence. If another supervisor wins the revision, the loser receives `CONFLICT` and must reload rather than overwrite.

Ledger loading fails closed for:

- missing or non-contiguous revisions;
- unknown files or directories;
- symbolic links, junction traversal, or non-regular entries;
- shared hard-linked published entries;
- unstable file identity, size, or timestamps while reading;
- invalid JSON or unknown schema fields;
- a broken SHA-256 chain;
- excessive entry or pending-file counts.

Bounded abandoned `.pending-<uuid>.json` files may be removed during recovery only after they are verified as direct, unshared regular files. A cleanup failure is not ignored.

## Deterministic restart recovery

Recovery consumes:

```text
persisted supervisor state
bounded process observations
currently published Runtime endpoint identity
recovery timestamp
bounded failure digest
```

It emits a versioned plan containing a new state plus explicit actions such as:

```text
hold
stop-runtime
resume-runtime
publish-runtime
rebind-managed-sessions
continue-canary
mark-needs-attention
```

Important cases include:

### Stable Runtime already healthy and published

The supervisor holds the endpoint. If the actual process reports a newer generation for the same release and instance, the recovered state records that observed identity without unnecessary republish or restart.

### Candidate preparation interrupted

If the live Runtime remains healthy and authoritative, the candidate is stopped and the state returns to stable. If the endpoint publication drifted, the live Runtime is resumed at a generation newer than every observed or published generation, then republished with revision/generation fences.

### Crash during quiesce or publication

If the candidate is already published and healthy, recovery continues with the candidate and requests managed-session rebinding plus canary monitoring. Otherwise a healthy live Runtime is resumed at a newer generation and republished; a non-authoritative candidate is stopped.

### Candidate active but unhealthy

A healthy previous Runtime is resumed at a newer generation, republished, and becomes the managed-session target. The failed candidate is stopped. If no healthy rollback target exists, recovery enters `needs-attention` rather than guessing.

### Rollback interrupted

Recovery completes the rollback with a generation and endpoint publication newer than all persisted, observed, and published identities. A missing rollback target enters `needs-attention`.

The planner rejects duplicate observed instance IDs, inconsistent alive/healthy flags, malformed publication data, and instance-ID reuse across releases.

## Managed-session registry

The managed-session registry distinguishes:

```text
managed sessions: desktop-owned clients with a rebind adapter
external sessions: clients whose transport cannot be replaced by the supervisor
```

Public snapshots contain only aggregate counts and counts by Runtime generation. Session IDs, authorization headers, connection bundles, and raw adapter errors are not returned.

Managed rebind behavior is:

1. validate the exact target identity;
2. skip sessions already bound to that target;
3. run bounded concurrent adapter calls with per-session deadlines;
4. if any adapter fails, roll successful sessions back by default;
5. report symbolic failure codes and aggregate counts;
6. mark `externalRefreshRequired` when any external session still references another target.

A second rebind operation is rejected while one is active. Rollback attempts receive their own bounded timeout and are not cancelled merely because the original cutover signal was aborted. If rollback itself fails, the report is `partial`; the supervisor must not declare the candidate committed.

## Failure-injection coverage

Automated tests cover:

- valid transition and rollback ordering;
- stale epoch and transition rejection;
- unknown state and publication fields;
- endpoint credential/query rejection;
- actual observed generation advancement;
- duplicate or impersonated Runtime observations;
- stable, candidate-preparation, publication, candidate-active, and rollback recovery;
- revision/hash CAS races;
- broken ledger chains and inventory corruption;
- shared hard links and abandoned pending files;
- successful managed-session rebind;
- external refresh reporting;
- partial rebind rollback;
- rollback-adapter failure;
- non-cooperative adapter timeout;
- concurrent rebind exclusion;
- aggregate-only snapshots and redacted error reports.

## Recovery action coordinator

`RuntimeSupervisorCoordinator` now joins the planner, append-only ledger, managed-session registry, and a narrow desktop action port. Recovery runs in this order:

1. load and verify the current ledger head;
2. reject a managed-session registry revision older than the persisted state;
3. observe bounded Runtime identities and the currently published endpoint under deadlines;
4. compute the deterministic recovery plan;
5. execute every action sequentially through generation/revision-fenced adapters;
6. require managed-session rebinding to complete atomically;
7. append the final state only after every action succeeds.

An action failure, timeout, cancellation, or ledger CAS conflict leaves the previous ledger head authoritative. A subsequent supervisor start reloads that head, observes actual process/publication state, and replans rather than replaying a stale in-memory plan. Reports contain action kinds, symbolic codes, aggregate session results, and SHA-256 error digests—not raw connection bundles, adapter errors, or authorization headers.

Observation and action ports have independent bounded deadlines. A non-cooperative action cannot hold the coordinator's execution lock indefinitely. Because an out-of-process action may still complete after its caller times out, adapters must also honor the abort signal and keep their own generation/revision fence; the coordinator deliberately does not pretend a timeout can undo an uncooperative external side effect.

The managed-session registry is frozen while a rebind is active. Registration, unregistration, and external-target updates fail with `SESSION_REBIND_BUSY`; registration closures carry an opaque token so a stale closure cannot remove a later session that reused the same public ID. The aggregate registry has a configurable upper bound and can start at the revision persisted by the supervisor ledger.

## Remaining desktop integration boundary

These facilities are exported from `@sovereign/update-core`. The following ownership-specific integration remains separate and must preserve the same fences:

- applying the workload admission gate to the Gateway ToolCatalog;
- exposing authenticated `runtime.transition.*` Runtime Host controls;
- wiring the Tauri/Rust Runtime Host owner to `RuntimeSupervisorStore` and `RuntimeSupervisorCoordinator`;
- launching a second verified Runtime Host from an immutable candidate slot;
- atomically publishing the active connection bundle;
- registering the desktop's actual managed MCP clients and reporting external clients;
- persisting the owner-visible recovery report and needs-attention state.

Until those owner-specific pieces are connected, this module is a verified persistent recovery executor, not a claim that the installed desktop automatically performs zero-downtime Runtime Host replacement.
