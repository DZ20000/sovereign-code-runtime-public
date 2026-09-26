# Contributing

Read the [development guide](docs/development.md), [repository layout](docs/repository-layout.md), and [SECURITY.md](SECURITY.md) first. This source preview has no promised review or response time.

Use a Git clone with a checked-out commit for Runtime Host bundles and packages. Keep a change narrowly scoped and preserve concurrent edits. Do not include runtime state, private histories, credentials, signing keys, installed binaries, screenshots of personal desktops, or machine-specific configuration. New tests should use synthetic fixtures and clean up only resources they create.

Before proposing a change, run the checks relevant to it. The public source workflow performs dependency installation, type checks, TypeScript integration tests, Tauri Rust/recovery tests, Android unit tests, native-resource preparation, and dependency audits; it does not perform installation, device acceptance, or live desktop acceptance. Record the exact tested commit, tool versions, command, exit code, and skipped tests. Rerun affected checks after changing their source or inputs. A passing test on another revision is not evidence for a new patch.

For dependency changes, review the upstream advisory and parent constraints, regenerate the lockfile with the declared pnpm version, test affected integration points, and refresh the license inventory and exact notice texts. Do not suppress new findings or use a broad forced major upgrade merely to obtain a green audit. Full dependency findings remain visible in a separate audit job.

Describe the behavior change, compatibility implications, validation, and limitations in the proposed change. Contributions must be material you have the right to submit under this repository's Apache-2.0 license; third-party material retains its own license and attribution. No contributor license agreement or project governance beyond these published terms is implied.

Use the [community conduct guidelines](CODE_OF_CONDUCT.md) for project interactions. Security reports follow the private-channel precautions in SECURITY.md rather than ordinary public issue reports.


## Pull request checklist

Before requesting review:

- [ ] Keep the change narrowly scoped.
- [ ] Record the exact tested commit SHA.
- [ ] Record Windows, Node.js, and pnpm versions used for validation.
- [ ] Run the checks relevant to the changed code.
- [ ] Do not include credentials, private workspace data, personal paths, or runtime state.
- [ ] Update the lockfile and third-party notices when dependencies change.
- [ ] Use Private Vulnerability Reporting for security-sensitive details.


## Worktrees and destructive operations

Work in the current worktree by default. Create a worktree only for genuinely concurrent, file-conflicting work. Do not create one for review, testing, packaging, installation, or another iteration of the same task. Managed worktrees live directly under `.worktrees/` and use `pnpm worktree:create -- <slug> [branch] [start-point]`. Finish only a confirmed idle, clean target with `pnpm worktree:finish -- <name>`; finish refuses ignored content too, and the branch remains available.

Never construct recursive deletion commands by string-concatenating nested shells. Never use `\"` as a PowerShell quote escape. Normalize and inspect every destructive target first. Refuse volume roots, repository roots, workspace roots, empty paths, current/parent paths, absolute escapes, UNC roots, symlink escapes, junction escapes, and reparse-point escapes. A timeout is an unknown execution state: inspect the original process and filesystem state before retrying.
