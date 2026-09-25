# Task and Agent Hub

Sovereign separates **user-level work** from the lower-level activity stream. The Tasks surface answers four operator questions directly:

1. Which project owns this work?
2. Which Agent is responsible, and when did it last check in?
3. What is the current step and reported progress?
4. Can the operator send a task-scoped instruction without guessing whether the Agent is still connected?

## Project and task model

Each project is shown as one large visual block. A project is bound to the authorized workspace itself or a descendant path and contains up to 200 retained tasks. The local registry retains at most 50 projects, 200 tasks per project and 500 tasks overall. Completed, failed and cancelled tasks remain retained and count toward both task limits. Task list pages contain at most 100 tasks; continue through `nextOffset` to retrieve the remaining tasks. The desktop groups and sorts tasks by status, while keeping project, task, Agent, step, progress and conversation metadata separate from raw tool arguments and output.

Task categories are intentionally small and stable:

```text
development
testing
build and release
research
maintenance
automation
other
```

Task states are:

```text
queued
planning
running
waiting-user
blocked
succeeded
failed
cancelled
```

`queued`, `planning` and `running` are active states. `waiting-user`, `blocked` and `failed` require attention. A running task whose heartbeat becomes stale or offline also raises project attention.

## Agent registration and heartbeat

Task reads (`tasks.list`, `tasks.get`, `tasks.inbox`, and `tasks.messages.list`) span all projects owned by the calling principal, regardless of the connection's current workspace. A task's project directory organizes its work; it does not restrict these metadata queries. Other principals' tasks remain hidden. Task mutations and file/command execution retain their existing workspace and ownership checks.

Task list responses are compact, revisioned and paginated. `tasks.list` accepts `offset` and `limit` (maximum 100) and returns `nextOffset`; callers continue until it is `null`. Each pretty-serialized page is bounded to 640 KiB, leaving headroom below the Runtime Host 1 MiB control-envelope limit, while `tasks.get` provides the full summary, steps and conversation for one selected task.

Connected Agents receive the following MCP tools:

```text
tasks.list
tasks.get
tasks.create
tasks.update
tasks.heartbeat
tasks.messages.list
tasks.message.send
```

An Agent should create or claim a task before substantial work, publish a bounded step plan, and call `tasks.heartbeat` while it is active. The heartbeat can update status, current step, progress and Agent identity in one call. It also returns queued user messages after the Agent's acknowledged message cursor.

Presence is derived locally from the last heartbeat:

```text
online   <= 45 seconds
stale    > 45 seconds and <= 5 minutes
offline  > 5 minutes
unknown  no heartbeat yet
```

When the Runtime Host disconnects, active Agent tasks are moved to `blocked` with a local system message rather than remaining green indefinitely.

## Task conversation

Opening a task shows a dedicated conversation pane. User messages are stored in the local task database and remain queued until the owning Agent reads them through heartbeat or message-list calls. The Agent advances an acknowledgement cursor; user messages at or below that sequence are marked acknowledged.

The conversation is task-scoped rather than a second general-purpose ChatGPT client. It is intended for status questions, priority changes and additional instructions. The retained conversation is bounded to 500 messages per task and 2,000 messages overall, with each message limited to 8,000 characters. Acknowledged user messages and older Agent/system messages are pruned first; unacknowledged user instructions are never silently discarded, and a new message is rejected when protected pending instructions consume the retention budget.
Desktop task detail returns the newest byte-bounded conversation window and marks it with `messagesTruncated` when older retained history exists. Agent message listing and heartbeat delivery are also byte-bounded; callers continue from the last returned sequence and acknowledge only messages actually received. These bounds keep both MCP serialization and the Runtime Host control protocol below their transport envelopes.

## Automatic inference

If meaningful external tool activity arrives without an active explicit task, Sovereign creates or reuses one inferred task for that principal and project. Inferred tasks are visually labelled and complete automatically when their associated activity set reaches zero. Task-management tools and passive polling calls are excluded so they cannot recursively create tasks or clutter Recent activity.

An explicit Agent task takes precedence over inferred activity on the Home and status surfaces. Underlying runs and direct tool calls remain available in Recent activity and Task History, but they do not inflate the user-level task count.

## Storage and boundaries

The task registry is stored in `tasks.sqlite` under the Runtime Host user-data directory. It uses WAL mode, foreign keys, bounded reads and bounded cardinality. Agent-created project roots must be existing directories that canonically resolve to the exact authorized workspace or a descendant; parent escapes, files, missing paths and escaping junctions or symlinks are rejected. Idempotency keys and Agent-facing task reads are scoped to the Agent principal, and a different principal cannot inspect, update, heartbeat or speak as the Agent on an owned task.

The task lifecycle contains summaries and safe metadata only. It does not copy raw command text, typed text, file contents, tool inputs, secrets or output into task records automatically. The normal run and audit stores remain authoritative for low-level execution history.
