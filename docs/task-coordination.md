# Task coordination and authenticated session leases

## Boundaries

Operator conversation, Agent-to-Agent coordination, Task ownership, session presence,
and Task workflow status are separate concepts. `tasks.message.send` writes an
assistant message to the current owner's operator-visible conversation. It cannot
be used to take over another Task. Inter-Task communication uses
`tasks.coordination.*` and never writes to `task_messages`, advances the operator
acknowledgement cursor, changes Task progress/status, or transfers ownership.

An operator message still enters the ordinary conversation and its operator unread
count. Message-write responses contain the newest three messages plus explicit
truncation and sequence metadata; retrieve additional history with `tasks.get` or
`tasks.messages.list`. Ordinary `tasks.get` still defaults to 200 messages.

Workflow completion does not close that operator-visible conversation. The unchanged
current owner and principal may append a final or corrective assistant/system message
after the Task becomes terminal. That terminal write never establishes, renews or
reopens a Task session lease; current-owner and principal checks still apply. While a
Task is non-terminal, an explicit transport write requires a live exact owner session,
although a previously unseen trusted transport may establish its first binding.

A coordination envelope is advisory evidence, not permission to execute code,
publish, install, activate, roll back, delete data, or restart a process. Those
operations retain their own authorization and release procedures.

## Ownership and transport identity

`tasks.claim` explicitly changes the owner of an unassigned, stale or offline
non-terminal formal Task. `expectedCurrentAgentId` provides compare-and-swap
protection. A different Agent cannot replace an online owner. `tasks.unassign`
requires the current owner. Update, heartbeat and conversation-send operations
verify the current Agent ID and authenticated principal rather than silently
rewriting ownership. Task creation/claim and their lease writes are atomic; a
rejected lease leaves no partial Task, ownership change or audit message.

The Gateway creates the transport session ID and injects it into trusted tool
execution context. Input `sourceSessionId` / `sessionId` names a logical mailbox
session, not a caller-supplied substitute for the authenticated transport session.
Logical session bindings are immutable per Task/Agent/principal. Current-owner
checks happen on mailbox access. Principal identity remains the security boundary;
Agent names and mailbox IDs alone are not independent authentication credentials.

## Persistent session presence

`task_agent_session_leases_v1` stores owner-bound transport leases. Authenticated
requests and tool activity renew only existing matching transport bindings. Generic
activity from an unbound transport is not attached to another Agent's formal Task
merely because they share a principal. Explicit owner-authenticated Task and mailbox
operations establish the corresponding binding.

For the current owner, the newest open lease is online for 45 seconds after its
last observation, stale after that window, and offline when its five-minute expiry
is reached. Explicit transport closure is offline immediately unless another open
current-owner lease remains live. Expiry/closure never changes Task workflow status,
current step, progress or operator unread state. Renewing a lease never automatically
resumes a blocked Task. Persisted absolute timestamps survive database reopening;
old observations do not move a lease's renewal timestamp backwards.

Owner transfer closes the previous owner's leases. Closed explicit transport IDs
cannot be reopened or rebound. Legacy internal callers without transport context
use a deterministic owner-bound compatibility lease; a later explicit reassignment
creates a new legacy generation without reopening the old record. A supplied
`legacy-` prefix does not grant that compatibility behavior. Startup seeds legacy
heartbeat history only for Tasks that have no lease records. Stored Task heartbeat
values remain audit data, not authority over existing leases. The compatibility
`agent.lastHeartbeatAt` response field reflects the selected lease observation.

Each Task retains at most 256 lease records and 256 logical mailbox bindings.
Closed bindings are retained, not silently recycled. Exhaustion fails closed and
requires explicit lifecycle/retention maintenance; this implementation does not
provide an automatic lease-history compactor.

## Coordination API

`tasks.coordination.directory` lists endpoint metadata within the authorized
workspace. `tasks.coordination.pending` discovers pending mail for Tasks currently
owned by the caller's Agent/principal and does not mark it read.

`tasks.coordination.send` takes `sourceTaskId`, `sourceSessionId`, `sourceAgentId`,
`targetTaskId`, `content`, and a stable `idempotencyKey`. For a new operation, both
endpoints must be assigned formal Tasks in the same project and inside the
authorized workspace. Inferred activity is not an endpoint. A new `broadcast`
accepts 1–32 unique explicit `targetTaskIds`; validation, sequence allocation and
all target writes are atomic.
An invalid target, mixed operation key, exhausted capacity or oversized response
rolls the entire operation back.

A source Task's key cannot be reused for a different target, body or operation.
Send/broadcast retries normalize body defaults, absolute expiry and broadcast target
order before looking up persisted idempotency records. Exact replay authenticates
the source formal Task's current principal/workspace and the original recorded
sending Agent; later unassignment does not substitute a new sending identity.
It returns the original envelope/batch and current message state even after either
endpoint becomes terminal/unassigned or messages are acknowledged, cancelled,
expired or replied. It does not bind sessions, renew leases, allocate sequences,
or reapply new-operation capacity/expiry limits. A new key still requires eligible
current endpoints. A broadcast has one server-generated correlation ID, and its
replay excludes subsequent replies in the same thread.

`inbox` uses a recipient sequence cursor; `outbox` uses a sender sequence cursor.
`thread` filters a correlation by the current Task/principal and uses a store-wide
ordinal cursor. Returned live incoming messages are marked delivered and read;
`acknowledge` remains an explicit action for acknowledgement-required messages.
`acknowledgeThrough` affects only already-read, live, acknowledgement-required
messages through the supplied recipient sequence. A reply reverses the endpoints,
keeps the correlation and atomically acknowledges the parent. Cancellation preserves
the envelope; acknowledged/replied messages cannot be cancelled.

Delivery states are `queued`, `delivered`, `read`, `acknowledged`, `replied`,
`cancelled`, `expired`, and `recipient-changed`. They are communication states, not
workflow completion states. A changed principal cannot read or acknowledge the
previous principal's mailbox. A new Agent under the same principal may recover
Task-addressed history; immutable intended/delivered identity snapshots expose the
handoff instead of relabelling the original sender.

A returned message is one causal envelope, not a collection of independent
optional fields. `deliveredAt` and the delivered session/Agent/name identity tuple
are all present or all absent. Read requires delivery; acknowledgement requires
read; reply requires acknowledgement. A no-acknowledgement message gains an
acknowledgement receipt only as part of an atomic reply. Cancellation may precede
delivery or follow delivery/read, but never coexists with acknowledgement or reply.
Existing receipts are monotonic from creation through delivery, read,
acknowledgement and reply, while cancellation cannot precede any delivery/read
receipt already present. Delivery, read, acknowledgement and cancellation occur
before explicit expiry. `expiredAt` is a derived receipt: it is present exactly when
the explicit expiry is at or before the snapshot time, and denotes that same
instant.

The projected state is recomputed in persisted precedence order: replied,
acknowledged, cancelled, no-ack read, expired, read, delivered,
recipient-changed, then queued. Consequently later expiry does not relabel a
replied, acknowledged, cancelled or no-ack read message. Current ownership implies
current principal, but terminal Tasks and old-principal histories remain readable
when their immutable receipt and identity chains are otherwise valid.

Offline assigned Tasks may receive queued mail. New send/broadcast operations to
or from terminal Tasks are rejected, including new notices. Existing terminal
history remains readable, and a correlated reply/cancellation is permitted subject
to the same principal and project checks. This is intentionally stricter than the
previous unverified completion report's terminal-notice claim.

## Bounds and migration

Message content is limited to 8,000 characters; explicit message expiry is at most
30 days. Pages contain at most 100 messages. Retained coordination history is
limited to 100,000 messages and pending mail to 1,000 messages per Task. Mailbox and
broadcast response bodies are bounded to 512 KiB. Capacity exhaustion is explicit;
there is no silent eviction of pending mail. Coordination history is independent of
ordinary conversation retention (500 messages per Task, 2,000 globally), which
preserves unacknowledged operator messages and transactional counters.

Versioned v2 metadata/session/cursor/message/broadcast tables are additive. When the
expected complete v1 schema exists, migration imports immutable provenance and
reply links, assigns monotonic v2 mailbox sequences, and retains v1 tables. Imported
keys are namespaced with `legacy-v1-*`; clients must not assume an old v1 key is a
new v2 operation key. Reopening is idempotent. Incompatible schemas or conflicting
immutable history fail closed. Normal v2 session renewal is not a migration
conflict. A savepoint protects import and cursor changes. Retained-message and
session bounds are checked before import.

There is no public Task-deletion API in this feature. Database foreign-key cascade
behavior is not a promise of indefinite history retention; do not bypass the API
with direct production-table deletion.

## Local operator coordination inbox

The Renderer uses the first-party desktop API `getTaskCoordinationInbox`, backed
by the canonical control method `tasks.coordination.operator-inbox`. Electron IPC,
Runtime Host and the Tauri bridge share this read-only projection. It is not the
Agent `tasks.coordination.inbox` operation and is not an additional MCP mailbox
capability. Opening, refreshing or inspecting it never marks messages delivered,
read or acknowledged, binds a mailbox session, renews a session lease, changes a
Task owner, or appends to the ordinary Task conversation.

Task cards expose `coordinationPendingCount` separately from ordinary unread user
messages, without changing their derived workflow lane or status. Task details
have a dedicated coordination panel with independent initial loading, empty,
latest-snapshot stale, and older-page loading/error states. The panel shows
`unreadCount` and `pendingCount` from one database read snapshot. Both are totals
across all pages
for the Task's current principal:
`unreadCount` is live pending mail not yet read by an Agent; `pendingCount` also
includes already-read mail still requiring acknowledgement. Cancelled, expired,
replied and completed mail do not count. Historical recipient identity remains
visible, but mail addressed to a previous principal does not become pending work
for its successor. The counts are not human viewing receipts.

The operator endpoint returns schema `scr.task-coordination-operator-inbox/v1`.
It defaults to the newest 50 messages, accepts a limit from 1 through 100, and uses
an exclusive positive `beforeSequence` cursor to retrieve older pages. Each page
is in increasing recipient sequence order, with explicit first/last boundaries,
`nextBeforeSequence` and `truncated`; the 512 KiB UTF-8 response budget can shorten
a page further. The panel loads the newest page first and exposes an accessible
Load earlier operation only while a continuation cursor exists. Older pages are
prepended in strict recipient-sequence order with duplicate suppression and a
preserved viewport anchor. Total counts always come from the server snapshot, not
from visible rows.

Coordination reads have their own 10-second timeout and manual refresh. Request
generations reject late results after navigation, including A-to-B-to-A switches,
and a latest-page refresh supersedes an in-flight older-page read. Refresh merges
the latest page into history already loaded for the same Task; only selecting a
different Task clears that history. Ordinary Task detail responses cannot overwrite
counts from a loaded coordination snapshot. An older-page failure only marks that
history operation; it does not make the latest snapshot stale. A latest-page
failure, timeout or malformed response retains the last successful messages and
counts but labels both as potentially out of date with their last successful update
time. The next valid latest response clears that state and updates the timestamp in
the same render. Initial failures use the unavailable state. Dedicated live status
regions announce freshness and history-operation changes; the message list itself
is not live, so a refresh does not replay every row to screen readers. Errors remain
isolated to the coordination panel and do not invoke Agent receipt APIs as a
fallback. Before adopting a response, the Renderer validates message schema,
ordering, counters and the full causal envelope described above. Partial delivered
identity, impossible receipt order, future receipts, derived-expiry mismatch or a
state/receipt contradiction fails closed and cannot replace the current panel
snapshot.

## Delivery scope

The source includes backend persistence, MCP tools, trusted Gateway session
propagation and the separate Renderer operator inbox described above. It does not
add push notifications or automatic human-view acknowledgement. Compilation and
tests do not establish installed-state acceptance: the Renderer, Runtime Host and
Shell bridge versions must be integrated and verified together before claiming
that an installed application provides this feature. No installation, activation,
hot update, Runtime/Shell/Guardian restart or release transaction is part of this
source-only change.

Validation receipts and the corrected session handoff must state the actual source
commit and command results. `pnpm build:code` and Tauri `build:web` compile without
running the repository's packaging/restart smoke sequence. The root `pnpm build`
and `pnpm test` aggregates include additional packaging, visual and process smoke
operations and are not interchangeable with safe compilation and full Vitest.
