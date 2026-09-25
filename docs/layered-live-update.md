# Layered live-update architecture

This document covers the update layers after the separately developed live tool-pack catalog. It deliberately does not load arbitrary code into a trusted process and does not attempt in-process replacement of the Tauri shell, Preload boundary, Node runtime, Host Guardian, or native agent.

## Signed release diff planning

`planVerifiedReleaseUpdate` compares the already-verified current and candidate release manifests and feeds an exact component diff into the strategy planner. Added and removed components retain their signed role, while a role change or case-only path rename is converted into an unknown `role-transition:*` role. That deliberately forces a controlled restart instead of allowing a candidate to relabel a Preload, shell, or native component as renderer content to obtain a less disruptive path.

No component change is inferred from a display version alone. The decision uses signed path, role, digest, and byte length. Database migration mode remains an explicit release policy input.

## Safety model

Every candidate still enters through the existing signed-release pipeline:

1. verify the Ed25519 release envelope and exact component inventory;
2. stage immutable candidate bytes outside the active release;
3. run compatibility and isolation preflight;
4. choose the least disruptive proven-safe strategy from the component diff;
5. retain an authenticated rollback target until the observation window passes.

`planComponentUpdate` in `packages/update-core/src/update-plan.ts` fails unknown component roles closed to a controlled application restart. Its strategies are:

| Strategy              | Eligible changes                                                        | Runtime Host                                     | Desktop shell |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ------------- |
| `renderer-reload`     | Immutable renderer assets only                                          | Preserved                                        | Preserved     |
| `runtime-rolling`     | Runtime Host, Gateway, and explicitly online expand-only schema changes | Candidate replaces active after drain and canary | Preserved     |
| `application-restart` | Shell, Preload, Node, Guardian, native agent, mixed or unknown changes  | Restarted and restored                           | Restarted     |
| `maintenance`         | Contract or breaking schema migration                                   | Quiesced                                         | Restarted     |

## Signed-release component planning

`parseReleaseSnapshot`, `diffReleaseSnapshots`, and `planReleaseTransition` turn two verified release inventories into the conservative component diff consumed by `planComponentUpdate`.

The diff layer rejects non-increasing release sequences, release identity reuse, unsafe or case-colliding paths, noncanonical versions, unknown fields, invalid roles, and malformed digests. A role transition is deliberately represented as removal of the old role plus addition of the new role. This prevents a candidate from relabeling a native executable as a renderer asset to obtain a less disruptive strategy.

A release with only metadata changes produces `no-op`; renderer asset changes select `renderer-reload`; Runtime Host or Gateway changes select `runtime-rolling`; and any native/trust-boundary role still selects a controlled restart.

## Durable cutover journal

`LayeredCutoverJournal` stores each renderer or Runtime Host cutover as an append-only, bounded, SHA-256-chained sequence beneath a dedicated cutover directory. It records the immutable active/candidate release identity, every coordinator phase, bounded non-secret details, recovery intent, and the terminal outcome.

Main-phase journal writes are fail-closed and occur before their corresponding mutation. Cleanup transitions are best-effort so a full journal cannot block traffic restoration, active-host resume, candidate termination, renderer-pointer rollback, or previous-renderer restoration. Final completion-journal failure is reported as cleanup evidence rather than causing a physically committed candidate to be rolled back solely because observability storage failed.

On startup, `listInterrupted()` classifies unfinished transactions into explicit recovery actions:

```text
renderer before activation       -> discard candidate
renderer after activation        -> restore previous renderer
renderer after observation       -> verify renderer commit
runtime before quiescence        -> stop candidate
runtime after quiescence         -> resume active and stop candidate
runtime after traffic switch     -> restore previous traffic
runtime after candidate commit   -> verify runtime commit
```

The host adapter must write the recovery-intent record before it performs a recovery mutation, then close the journal only after the authoritative endpoint or renderer pointer has been verified.

## Renderer slots and cutover

`RendererSlotStore` installs each renderer release beneath a versioned immutable slot. It:

- requires a strict versioned manifest with an exact file inventory;
- rejects absolute paths, traversal, backslashes, case-insensitive collisions, symbolic links, extra files, and reserved metadata collisions;
- verifies byte length and SHA-256 both while staging and whenever a slot is activated or resolved;
- keeps an atomic generation-numbered active pointer with one rollback release;
- uses compare-and-swap generation checks to reject stale activations;
- refuses to resolve a tampered active slot;
- prunes neither the active slot nor its rollback slot.

`RendererCutoverCoordinator` supplies the stateful UI transaction:

```text
verify candidate
  -> isolated renderer preflight
  -> capture bounded JSON view state
  -> compare-and-swap active pointer
  -> reload candidate
  -> wait for ready handshake
  -> restore view state
  -> observe candidate
  -> commit
```

A failure after activation rolls the pointer back, reloads the previous renderer, waits for its ready handshake, and restores the same captured state. A rollback failure is reported as `failed`, never as a successful update. Only one renderer cutover may run at a time.

The desktop adapter must capture only bounded non-secret UI state. Authoritative Tasks, messages, approvals, Runs, terminal metadata, and artifacts remain in Runtime Host persistence; they must not depend on the renderer snapshot.

## Authoritative Runtime endpoint registry

`RuntimeEndpointRegistry` is the local routing authority used by a rolling Runtime Host cutover. It stores immutable, non-secret endpoint records and a generation-numbered active pointer. Endpoint records contain only opaque endpoint identity, process and protocol identity, release identity, and the verified manifest digest; bearer tokens and session secrets are never written to this registry.

The active pointer binds:

```text
active instance record digest
previous instance record digest
checkpoint ID
fencing token
generation
switch timestamp
```

Every forward or rollback switch is compare-and-swap guarded by the observed generation and, for a forward switch, the expected active instance. Cross-process mutation locking prevents two candidate cutovers from winning the same generation. An interrupted Windows pointer replacement can recover the most recent backup, and the active endpoint is re-read and checked against the record digest before use. Active and rollback endpoint records cannot be removed.

`RegisteredRuntimeCutoverAdapter` connects the generic Runtime cutover coordinator to this registry and a process-lifecycle implementation. It verifies that a candidate process reports the expected release ID and manifest digest, requires the current endpoint before quiesce/drain/checkpoint, makes the registry pointer the sole traffic switch authority, and requires the committed pointer to carry the exact checkpoint fencing token before process-level commit succeeds.

The still-platform-specific lifecycle adapter must provide candidate process launch, private control endpoint setup, protocol health, quiesce, drain, durable task checkpoint, canary, resume, commit, and stop. It must not store connection secrets in the endpoint record.

## Runtime Host rolling cutover

`RuntimeCutoverCoordinator` defines the host-independent transaction used by the Tauri process adapter:

```text
start isolated candidate
  -> health and protocol preflight
  -> quiesce active host
  -> drain consequential and read calls
  -> require inFlight=0 and unknown=0
  -> persist checkpoint and fencing token
  -> switch the authoritative traffic endpoint
  -> canary candidate
  -> commit candidate
  -> retire previous host
```

Before traffic switches, any failure leaves the active host authoritative. After traffic switches, any canary or commit failure switches traffic back, resumes the previous host, and stops the candidate. Failure to restore traffic is a fail-closed `failed` outcome. A failure merely to retire an already non-authoritative old host is a committed update with a cleanup warning for Guardian to finish.

Every adapter phase receives an `AbortSignal` and a hard deadline. Adapter implementations must honor cancellation and must use the supplied checkpoint fencing token for all post-cutover writes. A second cutover is rejected rather than queued against a stale active-host handle.

## Implemented Runtime Host traffic and control substrate

The Gateway and Runtime Host now expose the cutover mechanics required by the coordinator:

- the Gateway has a generation-fenced admission gate that rejects new authenticated MCP requests with `503 RUNTIME_QUIESCED` while already admitted requests continue to completion;
- existing long-lived MCP `GET`/SSE subscriptions remain session-liveness channels but do not masquerade as in-flight tool work, so they cannot block a safe drain; new subscriptions are still rejected after quiescence;
- `/healthz` remains available during quiescence and reports accepting state, active request count, sessions, pending initializations, and generation;
- `waitForIdle` returns explicit drained, timeout, and interrupted evidence rather than inferring safety from process liveness;
- Runtime Host control requests are independently counted and quiesced, so local desktop calls cannot race a Gateway-only drain;
- passive candidate processes accept only bounded read-only inspection plus lifecycle commands until a 256-bit promotion fencing token is verified;
- a trusted local supervisor can inject the same 256-bit Gateway bearer credential into active and candidate hosts, preserving existing MCP authentication across the local listener handoff without persisting the secret;
- `cutover.status`, `cutover.quiesce`, `cutover.drain`, `cutover.checkpoint`, `cutover.detach`, `cutover.resume`, `cutover.promote`, and `cutover.canary` are part of the local authenticated control protocol;
- checkpoint evidence binds the expected external-route intent to the Task/Run snapshot and fencing token; `cutover.detach` stops the old public route only after control and Gateway traffic have drained;
- promotion restores the bound public-route intent on the candidate, while rollback resumes both Gateway admission and the old external route from the same checkpoint; a route-restoration failure re-quiesces Gateway traffic and remains fail-closed;
- checkpoint and canary state are canonicalized, size bounded, and represented by SHA-256 evidence; authoritative Task and run data remain in the existing persistent stores;
- controller initialization suppresses persisted auto-start when the process is a passive candidate, and promotion is the only path that releases that restriction.

The control protocol does not itself select a candidate executable or redirect the Tauri shell. Those responsibilities remain in the native supervisor described below.

## Unified layered coordinator

`LayeredUpdateCoordinator` is the single-flight routing boundary after signature and exact-inventory verification. It recomputes the update strategy from the authenticated component diff instead of accepting a caller-selected mode, and then delegates to exactly one mechanism:

```text
renderer-reload       -> RendererCutoverCoordinator
runtime-rolling       -> RuntimeCutoverCoordinator
application-restart   -> signed restart adapter
maintenance           -> signed maintenance/restart adapter
no-op                 -> no side effect
```

The candidate carries release sequence, signed manifest digest, signing-key ID, verification time, and the verified component changes. Verification evidence older than 24 hours is rejected so a long-lived UI object cannot silently become update authority. Live-adapter inputs are mandatory for their selected strategy; a missing renderer or Runtime Host candidate fails closed rather than falling through to another path.

The coordinator propagates cancellation, refuses concurrent executions rather than queueing a stale candidate, records bounded transitions, and preserves the delegated cutover receipt. Observer failures cannot change authority. Tool-pack hot reload is explicitly outside this coordinator and remains owned by the separate tool catalog implementation.

## Runtime traffic authority

`RuntimeTrafficRegistry` is the process-local route and drain boundary used by the rolling adapter. A call acquires a lease against the current host and generation before dispatch. The registry tracks read and consequential calls separately from their outcome:

```text
completed
cancelled
unknown
```

Quiescing the active host rejects new leases. Drain waits for every in-flight lease and reports cancellation and unknown-result counts. A switch is rejected unless the expected generation still matches, the source is authoritative and quiesced, in-flight work is zero, unknown side effects are reconciled, the target uses a distinct instance ID, and a durable checkpoint fencing token is supplied. The active route and generation change together; stale callers then fail their generation check.

`RuntimeTrafficCutoverAdapter` binds this registry to `RuntimeCutoverCoordinator`. Shell-specific lifecycle callbacks still start and health-check a candidate, persist the Task checkpoint, run the canary, commit the candidate, and terminate non-authoritative processes. On rollback, the adapter quiesces and drains the candidate route before switching back. It refuses to stop whichever host is currently authoritative and refuses commit when the traffic fence differs from the durable checkpoint fence.

The registry is intentionally process-local. The signed release journal, Task checkpoint, fencing token, and last-known-good release remain durable authorities across a Tauri shell restart.

## Layered orchestration

`LayeredUpdateOrchestrator` is the single-flight entrypoint after signed release verification. It recomputes the component diff, optionally enforces an expected strategy selected by the UI, and dispatches exactly one handler:

```text
renderer-reload      -> durable renderer cutover
runtime-rolling      -> durable Runtime Host cutover
application-restart  -> signed Guardian-managed restart
maintenance          -> quiesced migration and restart
```

Unchanged releases and explicit dry runs do not invoke a handler. Handler exceptions and receipt identity mismatches become bounded failed receipts. A second execution is rejected rather than queued against a stale current-release assumption. The concrete desktop integration must bind these handlers to the existing signed candidate slot, Tauri shell, Runtime Host process manager, Guardian, and update audit store.

## Mutation gate and recovery controller

`LayeredUpdateController` is the host-facing boundary above planning, execution, status, and recovery. It blocks a mutating update unless the status projection is `ready`; `recovery-required`, `manual-intervention`, and `uninitialized` states must be resolved first. Signed planning and explicit dry runs remain available because they do not change authority.

The controller exposes one safe recovery operation and a bounded `recoverAllSafe` loop. Each recovery is rechecked against the latest status before execution and must disappear from the durable recovery projection afterward. Manual plans remain visible and are never silently skipped as successful work. Concurrent controller, orchestrator, or recovery operations are rejected rather than queued against stale authority.

## Runtime Host and Gateway quiescence controls

The Runtime Host now owns a concrete `RuntimeHostCallGate`, and each active Gateway owns a `GatewayRequestGate`. The Gateway gate counts bounded MCP `POST` request/response operations but deliberately excludes long-lived `GET` event streams. When quiesced it returns a bounded `503` JSON-RPC error with `Retry-After: 1`, while already accepted requests are allowed to finish and are included in drain.

The Runtime Host control protocol exposes a narrow update-only surface:

```text
runtime.cutover.status
runtime.cutover.quiesce { epoch, reason }
runtime.cutover.drain { epoch, timeoutMs }
runtime.cutover.checkpoint.status
runtime.cutover.checkpoint.prepare {
  epoch, cutoverId, sourceReleaseId, candidateReleaseId,
  runtimeManifestSha256, taskSnapshotSha256,
  taskCount, lastMessageSequence, activeRunIds
}
runtime.cutover.checkpoint.adopt { checkpointId, candidateInstanceId }
runtime.cutover.checkpoint.commit { checkpointId, candidateInstanceId }
runtime.cutover.checkpoint.rollback { checkpointId, reason }
runtime.cutover.resume { epoch }
runtime.cutover.reconcile { callId, resolution }
```

These methods bypass normal call accounting so `drain` cannot wait on itself. Every other desktop control request is classified conservatively: a small explicit read allowlist is non-consequential; unknown/future methods and `tool.invoke` are consequential. A failed consequential call is retained as `unknown` until an operator or idempotency/evidence layer reconciles it. New normal calls are rejected while quiesced.

Quiescence first closes the Gateway admission gate and then closes the Runtime Host control gate. If host quiescence fails, Gateway admission is restored. Resume prevalidates both epochs before opening either side and is blocked while a prepared or adopted durable checkpoint remains active. Checkpoint preparation itself is rejected unless both gates are quiesced and drained at the same epoch with zero unknown host-side outcomes. Drain completes only after both the Runtime Host control calls and Gateway MCP posts reach zero; unknown host-side effects are surfaced for the rolling coordinator to reject before traffic switching.

The Gateway cutover control is handed to Runtime Host through an explicit lifecycle callback when the Gateway starts and is cleared when it closes. It is not a global singleton, and tool-pack live reload remains unrelated.

The Runtime Host smoke launches the real bundled host, starts Gateway, quiesces both gates, proves a normal `state.get` is rejected, drains to zero, resumes both gates, and verifies normal control traffic works again.

## Desktop integration contract

The remaining native integration binds the verified release slots to the Tauri supervisor:

- start a candidate Runtime Host from a verified immutable release on a private control endpoint with a fresh instance ID, promotion fencing token, and the active host's memory-only Gateway bearer credential;
- verify candidate release identity, protocol status, passive policy, and private Gateway readiness before the active host is quiesced;
- call the implemented control drain and checkpoint methods, detach the old external route, then atomically replace the Tauri-owned active Runtime Host handle;
- promote the candidate with the checkpoint-bound external-route intent, verify that its connection bundle retains the same bearer credential, and run an authenticated canary;
- shut down the previous host only after commit, or switch the handle back and call `cutover.resume` to restore both old Gateway admission and the old external route on failure;
- feed the resulting receipt into the existing update state machine and audit store;
- leave Guardian responsible for controlled application-restart updates and for cleaning up a non-authoritative process that could not be retired.

Native and trust-boundary components remain controlled-restart updates. This is intentional: user-visible continuity comes from checkpoint and restore, not from unsafe ABI-level hot patching.

## Verification

The update-core tests cover:

- fail-closed strategy selection;
- immutable renderer staging and digest verification;
- traversal, extra-file, case-collision, stale-generation, and tamper rejection;
- renderer activation, state handoff, observation, rollback, and rollback failure;
- Runtime Host drain, checkpoint, route detach, and route restoration ordering;
- long-lived MCP GET/SSE subscriptions not blocking a safe tool-call drain;
- supervisor-injected Gateway credential continuity across active and candidate hosts;
- checkpoint and fencing-token rejection before external traffic detach;
- unhealthy and passive candidate rejection before authority transfer;
- post-switch canary rollback;
- fail-closed Gateway re-quiescence when external-route restoration fails;
- phase timeouts and single-flight cutover enforcement.

## Durable crash recovery

The cutover coordinators are backed by an append-only cutover ledger, an authoritative Runtime route registry, and authority-aware recovery inspection. See [durable-cutover-recovery.md](durable-cutover-recovery.md).

## Durable native restart path

Native and trust-boundary updates use a cross-process restart journal, safe-point check, checkpoint/fencing reference, candidate resume, and two-launch rollback protocol. See [application-restart-updates.md](application-restart-updates.md).
