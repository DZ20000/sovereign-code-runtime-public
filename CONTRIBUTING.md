# Contributing

Sovereign accepts narrowly scoped contributions that preserve its authority and evidence boundaries. This source preview has no promised review or response time.

## Start here

1. Read the [development guide](docs/development.md), the [repository layout](docs/repository-layout.md), and [SECURITY.md](SECURITY.md).
2. Run the small continuity demo to see the Task/session model in action:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm demo:continuity
   ```

3. Choose the smallest validation set that covers your change.
4. Keep generated state, credentials, private histories, local screenshots, signing keys, and machine-specific configuration out of the patch.

## Useful contribution paths

### Good first changes

- clarify a confusing error or empty state;
- improve English or Chinese documentation;
- add a deterministic fixture or regression test;
- improve accessibility without changing authority behavior;
- document an environment-specific compatibility result;
- improve first-run diagnostics.

### Intermediate changes

- add bounded context or audit presentation;
- strengthen Task, message, or session-continuity tests;
- improve capability discovery or Tool Pack documentation;
- add a reviewed low-risk tool with explicit schema, policy, and evidence;
- improve failure classification without hiding unknown outcomes.

### Authority-sensitive changes

Changes involving workspace containment, session leases, Task ownership, approvals, elevation, credential handling, Runtime cutover, update signing, fencing, or unknown execution outcomes require explicit invariant analysis and focused tests. Do not broaden authority merely to simplify an implementation.

## Repository hygiene

Use a Git clone with a checked-out commit for Runtime Host bundles and packages. Keep each change narrowly scoped and preserve concurrent edits. Do not reset or rewrite shared history.

Do not include:

- runtime databases or `.scr` state;
- credentials, Tunnel keys, access tokens, signing material, or personal data;
- installed binaries or screenshots of personal desktops;
- generated artifacts that the repository deliberately ignores;
- unrelated local experiments.

New tests must use synthetic fixtures and clean up only the resources they create.

## Validation

Run checks against the exact revision you intend to submit. A passing result from another revision is not evidence for the current patch.

Common commands:

```powershell
pnpm test:demo-continuity
pnpm typecheck
pnpm exec vitest run <affected-test-files>
pnpm test:visual
pnpm verify:push
```

Choose checks appropriate to the changed behavior. The public source workflow performs dependency installation, type checks, TypeScript integration tests, Tauri Rust/recovery tests, Android unit tests, native-resource preparation, and dependency audits; it does not perform installation, device acceptance, or live desktop acceptance. Packaging, installation, live desktop input, UAC, Tunnel routing, and real-device behavior require separate acceptance; do not infer them from source tests.

Record in the pull request:

- the exact commit tested;
- tool and operating-system versions when relevant;
- commands and exit codes;
- skipped or unavailable checks;
- known limitations;
- whether the result is source-only, packaged, installed, activated, or observed in a running environment.

For dependency changes, review the upstream advisory and parent constraints, regenerate the lockfile with the declared pnpm version, test affected integration points, and refresh the license inventory and exact notice texts. Do not suppress findings or force a broad major upgrade only to obtain a green audit.

## Pull-request boundary review

Explain whether the change affects any of the following:

- authorized workspace or path containment;
- permission level or native approval behavior;
- Task owner, principal, Agent identity, or session lease;
- message delivery, acknowledgement, expiry, or recipient identity;
- execution idempotency or unknown outcomes;
- credentials, DPAPI, Tunnel, proxy, or loopback exposure;
- Renderer, Runtime Host, Guardian, updater, checkpoint, or fencing authority;
- compatibility or persistence schemas.

If none apply, say so explicitly. If one applies, state the invariant that must remain true and point to the test or acceptance evidence.

## Worktrees and destructive operations

Work in the current worktree by default. Create a worktree only for genuinely concurrent, file-conflicting work. Do not create one for review, testing, packaging, installation, or another iteration of the same task. Managed worktrees live directly under `.worktrees/` and use `pnpm worktree:create -- <slug> [branch] [start-point]`. Finish only a confirmed idle, clean target with `pnpm worktree:finish -- <name>`; finish refuses ignored content too, and the branch remains available.

Never construct recursive deletion commands by string-concatenating nested shells. Never use `\"` as a PowerShell quote escape. Normalize and inspect every destructive target first. Refuse volume roots, repository roots, workspace roots, empty paths, current/parent paths, absolute escapes, UNC roots, symlink escapes, junction escapes, and reparse-point escapes. A timeout is an unknown execution state: inspect the original process and filesystem state before retrying.

Contributions must be material you have the right to submit under the repository's Apache-2.0 license. Third-party material retains its own license and attribution. No contributor license agreement or governance beyond the published repository terms is implied.

Use the [community conduct guidelines](CODE_OF_CONDUCT.md) for project interactions. Report security issues through the private-channel precautions in [SECURITY.md](SECURITY.md), not through a public Issue.
