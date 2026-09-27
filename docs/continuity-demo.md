# Continuity demo

The continuity demo is the smallest executable example of Sovereign's central claim:

> Work can survive a Runtime restart and an Agent-session replacement without allowing a closed session to regain authority.

## Run it

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm demo:continuity
```

For a machine-readable result:

```powershell
pnpm demo:continuity -- --json
```

To retain the isolated temporary directory for inspection:

```powershell
pnpm demo:continuity -- --keep
```

The normal run removes its temporary files when it finishes.

## What the demo actually exercises

The script imports the compiled `TaskRegistry` used by the control plane and creates a fresh SQLite database under the operating-system temporary directory. It then:

1. creates a formal Task owned by Agent Session A;
2. records a user instruction and an Agent checkpoint;
3. closes and reopens the Task registry to simulate a Runtime process restart;
4. verifies that Task state and messages persisted;
5. closes Session A and verifies that workflow state remains while Agent presence becomes offline;
6. resumes the same Task from Session B;
7. attempts another Agent message from the already-closed Session A;
8. requires that stale call to fail with `POLICY_DENIED`.

The test therefore covers real persistence and session-lease behavior rather than a presentation-only fixture.

## What it does not prove

The demo does not:

- connect to ChatGPT or the OpenAI Secure MCP Tunnel;
- start the desktop application, Gateway, Guardian, or Runtime Host process tree;
- execute Terminal, Python, browser, desktop, or filesystem mutations in a user workspace;
- validate native approval windows, UAC, installer behavior, Authenticode, or physical desktop input;
- prove general interrupted-command replay or offline task execution.

Those require their own integration, packaged, or physical-environment acceptance.

## Automated check

```powershell
pnpm test:demo-continuity
```

The test lives in `scripts/demo-continuity.test.mjs`. It uses the same implementation as the human-readable demo and asserts all four invariants:

```text
task persisted across restart
workflow state survived disconnect
replacement session resumed
closed session was rejected
```
