# Session handoff

A ChatGPT Web or Pro conversation can reach its context limit, compact, disconnect, or be replaced while local development remains unfinished. Sovereign's session-handoff command creates one bounded local recovery note so another verified session can re-anchor without preserving a transcript.

## Generate a handoff

When this work is bound to a Sovereign Task and the Tasks interface is available, read its inbox/card, acknowledge pending operator messages, and synchronize the current step. If that bound Task's interface is unavailable, create the local handoff first and note the unsynchronized Task state in `task.limitations`. Do not infer an empty inbox or invent a Task ID. Unbound local work has no Task synchronization requirement and may omit `task.id`; continuation anchors require it.

The recommended path is stdin so task state does not become a temporary workspace file or command-line argument:

```powershell
$handoff = @{
  schemaVersion = 'scr.session-handoff-input/v1'
  sessionRole = 'main'
  reason = 'context-limit'
  task = @{
    # Include id = '<known Sovereign Task ID>' only when this work is Task-bound.
    title = 'Short task title'
    goal = 'The user-visible result still being pursued.'
    currentStep = 'The exact verified step currently in progress.'
    completed = @(
      'One verified outcome.'
    )
    remaining = @(
      'The next end-to-end action.'
    )
    decisions = @(
      'A durable implementation decision that constrains the next session.'
    )
    limitations = @(
      'A real unresolved limitation.'
    )
    openQuestions = @()
    validation = @(
      @{
        name = 'pnpm typecheck'
        status = 'passed'
        summary = 'Completed against the current working tree.'
      }
    )
  }
} | ConvertTo-Json -Depth 8

$handoff | pnpm handoff:session
```

The command writes a new Markdown file below:

```text
.sovereign/handoffs/
```

The directory is local and Git-ignored. Existing handoffs are never overwritten. The default `sessionRole` is `main`; use `support` only when the task explicitly assigns a supporting conversation.

Report the local output path even if Task synchronization fails. Update the bound Task card with that path when access is available; keep synchronization pending otherwise. The generator does not contact the Tasks interface itself.

## Input contract

The input schema is `scr.session-handoff-input/v1`. It accepts only these bounded fields:

- session role and handoff reason;
- optional task ID, required title, goal, and current step;
- completed and remaining outcomes;
- durable decisions;
- limitations and open questions;
- validation name, status, and concise summary;
- optional task-bound continuation epoch and predecessor anchor.

Unknown fields fail closed. This prevents callers from adding raw transcripts, command logs, tool payloads, or arbitrary state to the handoff.

Supported reasons are:

```text
context-limit
connection-stop
compaction
manual
```

Supported validation statuses are:

```text
passed
failed
blocked
not-run
```

## Task-bound continuation anchors

A planned replacement or compaction may add this optional root field:

```json
{
  "continuation": {
    "epoch": 1
  }
}
```

The first epoch must not name a predecessor. Every later epoch must provide a lowercase SHA-256 `previousAnchorId` equal to the `anchorId` recorded in the previous handoff's continuation marker:

```json
{
  "continuation": {
    "epoch": 2,
    "previousAnchorId": "<previous anchor ID>"
  }
}
```

A continuation requires a Task ID. The generator appends one `scr.session-continuation-anchor/v1` marker that binds the Task ID, epoch, predecessor, exact repository/worktree identity, branch, HEAD, normalized handoff input, and the complete human-readable file body. `verifySessionContinuationAnchor` rejects body changes, malformed or duplicate markers, broken predecessor expectations, and mismatched Task or Git identity.

If the required Task ID or predecessor is unavailable, an ordinary local handoff can still preserve progress without a continuation marker. Record the missing correlation information in `task.limitations`; do not fabricate a predecessor or restart epoch numbering to conceal a fork.

The anchor is public correlation evidence, not authority. It is not a bearer token, turn token, browser lease, conversation URL, account automation marker, or permission grant. ChatGPT Web may create and consume it directly through the existing MCP/runtime workflow; no Codex process, computer-use session, controlled browser, or browser polling loop is required. On resume, Sovereign still revalidates the current Task owner/session lease, permission profile, live tool manifest, user instructions, and Git state.

This deliberately adopts only the useful checkpoint/continuation property of an epoch-bound handoff. Responses/SSE proxying, browser-tab ownership, and account-driving automation remain outside Sovereign's session-handoff architecture.

### Verify an existing continuation

Run this read-only example from the exact worktree root, replacing the filename and Task ID with known values. The example expects epoch 1. For a later epoch, set its known epoch and the verified predecessor's `anchorId`; do not copy expected identity from the file being checked. `null` represents the first epoch's missing predecessor and a detached Git branch when applicable.

```powershell
@'
import { readFile } from 'node:fs/promises';
import {
  collectGitEvidence,
  verifySessionContinuationAnchor,
} from './scripts/session-handoff.mjs';

const git = await collectGitEvidence('.');
const markdown = await readFile('.sovereign/handoffs/<existing-file>.md', 'utf8');
const anchor = verifySessionContinuationAnchor(markdown, {
  taskId: '<known Task ID>',
  epoch: 1,
  previousAnchorId: null,
  repositoryRoot: git.repositoryRoot,
  branch: git.branch,
  head: git.head,
});
console.log(`Verified continuation ${anchor.epoch}: ${anchor.anchorId}`);
'@ | node --input-type=module
```

Identity mismatch requires reconciliation with the current task and Git changes before relying on the chain. Verification does not authorize resetting the workspace or overwriting newer work. It does not validate the current dirty-file set; compare that state separately.

## Automatically collected evidence

The generator must run from the exact Git worktree root. It records only bounded metadata:

- repository and current worktree path;
- branch or detached state;
- full HEAD and subject;
- up to 200 porcelain status entries;
- up to eight recent commit identifiers, timestamps, and subjects;
- up to sixteen registered worktrees.

It does not read source contents or diffs. Secret-looking material found in caller-supplied task text is rejected. Secret-looking material in Git status paths and commit subjects is redacted. Exact repository and registered-worktree paths are retained as operational identity evidence.

## Safety boundary

The handoff is recovery evidence, not authority. It may be stale immediately after creation. A receiving session must re-check:

```text
current user request
Sovereign Tasks inbox and task card, when bound and available
Git root
branch
HEAD
working-tree status
registered worktrees
relevant source and tests
```

The receiver must reconcile differences rather than reset or clean the workspace to match the note. Unrelated dirty files and other sessions' work remain user data.

The handoff never contains credentials, private keys, one-time codes, source bodies, diffs, raw tool or command output, hidden reasoning, or scratchpad text. The generator rejects common credential patterns and private-reasoning labels before writing.

## Context-pressure limitation

The local runtime cannot inspect an opaque ChatGPT conversation's exact remaining context. The `session-handoff` Skill therefore triggers proactively when the model or operator observes pressure, before a planned replacement, after compaction when a fresh anchor is useful, or on explicit request. A future trusted observer may supply a pressure signal, but the artifact format does not depend on one.

## Resume workflow

1. Re-read the current user request. When Task-bound and the interface is available, open its card and read pending operator messages. If that bound Task is unavailable, record synchronization as pending.
2. Inspect current Git identity and state.
3. Read the newest relevant handoff under `.sovereign/handoffs/`.
4. Compare its evidence with current state and verify any continuation marker as shown above. Reconcile Git or task differences before editing.
5. Re-open the relevant source and tests.
6. Continue the smallest remaining end-to-end action.
7. Synchronize the bound task card when available and create a newer handoff only when continuity still matters. Preserve local progress while synchronization is unavailable; never append to or overwrite the old handoff.

## Public workflow identity

name: session-handoff

A continuing Agent reads the Tasks inbox before acting, revalidates current files and commands in the main session, and treats previous summaries as evidence, not authority. A handoff never restores authorization from a transcript or an old test result.
