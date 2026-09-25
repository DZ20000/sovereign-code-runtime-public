# Application restart transaction library

Native shell, Preload, Node runtime, Host Guardian, native-agent, and incompatible schema changes require a process restart. This document describes the **checkpointed restart transaction library** in `packages/update-core` and its adapter contract.

**Integration status:** the library and its isolated tests exist, but the desktop startup, restart shortcut, and NSIS installer do not call `ApplicationRestartCoordinator`. The current restart command stops and relaunches the application; it does not checkpoint or automatically resume running tasks. See [the actual restart and installation procedures](development.md#restart-and-shortcuts). Library tests do not establish desktop transaction or recovery coverage.

The implementation is split between:

```text
RestartJournal
  append-only restart intent and cross-process phase authority

ApplicationRestartCoordinator
  pre-restart safe point and checkpoint
  post-restart candidate validation
  rollback request and previous-release recovery
```

## Restart journal

`packages/update-core/src/restart-journal.ts` stores canonical entries beneath:

```text
<root>/entries/
  00000000000000000001-<digest-prefix>.json
  00000000000000000002-<digest-prefix>.json
```

Each restart intent binds:

```text
updateId
currentReleaseId
candidateReleaseId
restartId
checkpointId
checkpointSha256
fencingToken
```

The permitted state machine is:

```text
prepared
  -> restart-requested
    -> candidate-started
      -> candidate-healthy
        -> committed
      -> rollback-requested
        -> rolled-back
  -> failed
```

A previous release returning directly from `restart-requested` is recorded as `rolled-back`; this covers a candidate that never became active or was rejected by the Guardian before the application-level resume hook ran.

The journal enforces:

- exact schemas and bounded identifiers;
- canonical SHA-256 digest binding for checkpoints and every journal entry;
- contiguous sequence and hash chain;
- immutable identity until a terminal phase;
- only permitted phase transitions;
- one open restart intent at a time;
- private regular entry files and bounded sizes;
- cross-process append serialization and conservative stale-lock recovery;
- a new restart intent only after the previous one is terminal.

## Prepare before process exit

`ApplicationRestartCoordinator.prepare` does not write a restart intent until all of these have succeeded:

1. candidate release verification;
2. a safe-point report with `consequentialInFlight = 0` and `unknownOutcomes = 0`;
3. a persisted checkpoint with SHA-256 and a fresh fencing token.

It then appends `prepared`, appends `restart-requested`, and only afterward asks the platform adapter/Guardian to launch the candidate. If the launch request itself fails while the current process remains alive, the journal is closed as `failed` instead of leaving an ambiguous open restart.

Production adapters must make the restart request idempotent by `restartId` and must ensure the current process exits only after the durable `restart-requested` phase is visible.

## Resume in the new process

A future desktop adapter must call `resume(runningReleaseId)` at startup. The library then follows these paths:

### Candidate is running

```text
restart-requested
  -> candidate-started
  -> candidate health and protocol checks
  -> candidate-healthy
  -> restore checkpoint
  -> commit candidate release pointers
  -> committed
```

If candidate health, restore, or commit fails, the coordinator appends `rollback-requested` before asking the Guardian to restart the previous release. It returns a `rollback-requested` receipt because the rollback is not complete until another process starts.

### Previous release is running

For `restart-requested` or `rollback-requested`, the coordinator verifies the previous release, restores the same checkpoint, and closes the journal as `rolled-back`. This is the only point at which rollback is considered complete.

### Unrelated release is running

The intent is closed as `failed`. It is never silently attached to a release that does not match either side of the signed transaction.

## Checkpoint boundary

The checkpoint reference in the restart journal contains only:

```text
checkpointId
checkpointSha256
fencingToken
```

The actual checkpoint remains in an independently verified persistent store. It should include Task/message cursors, run metadata, active view and bounded drafts, but not plaintext credentials or unbounded terminal output. Every post-restart consequential write must reject an expired fencing token.

## Platform adapter requirements

The desktop/Guardian integration must provide:

- signed candidate verification and preflight;
- safe-point inspection over real in-flight operations;
- idempotent checkpoint creation;
- idempotent restart request keyed by `restartId`;
- candidate and previous-release health checks;
- checkpoint restore that is safe to retry;
- atomic candidate commit after health and restore;
- explicit rollback request to the last-known-good release.

The application coordinator is single-flight and every phase is deadline bounded. Timeouts abort the phase. A process crash is recovered by replaying the journal from the last durable phase rather than by guessing from UI state.

## Verification

Focused coverage includes:

- successful prepare and candidate commit;
- candidate-health failure followed by a two-process rollback;
- previous-release return before candidate activation;
- failed restart request closing the journal;
- safe-point and checkpoint rejection before any intent is persisted;
- unrelated-release startup failure;
- concurrent-operation rejection;
- journal idempotency, invalid transitions, cross-instance serialization, tamper detection, and multiple sequential intents.
