# Secure execution and credential references

Sovereign can expose the optional `secure-execution` tool pack. The pack combines metadata-only public credential references, protected reference storage, unified audit receipts, and Docker Sandboxes microVM operations. It is disabled by default because sandbox creation depends on a separately installed and authenticated `sbx` executable.

## Host prerequisites

The reviewed Windows provider is Docker Sandboxes `sbx` 0.39.0.

```powershell
winget install -h Docker.sbx
sbx version
sbx login
```

The reviewed Windows x64 executable identity is:

```text
version: 0.39.0
sbx.exe SHA-256:
b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf
```

The corresponding WinGet 0.39.0 MSI manifest identifies installer SHA-256:

```text
f1189f3d2d80c60091eee9e1a852132c8e678ce06725fa2e029d42f45ea038e9
```

Sovereign streams and hashes the installed executable within a reviewed size bound, verifies the exact `sbx version` output, and validates the `sbx ls --json` response schema before any sandbox list, create, execute, stop, or removal operation. Executable identity, CLI compatibility, and Docker authentication are reported separately. A version, hash, or schema mismatch fails closed.

Docker Sandboxes on Windows also requires Windows 11 and Windows Hypervisor Platform. Installation, feature enablement, Docker account sign-in, and organization governance remain explicit local-operator actions; Sovereign does not automate them through an Agent tool.

## Enable the pack

Keep the default developer tools and optional semantic tools as needed, then add `secure-execution`:

```json
{
  "schemaVersion": "scr.tool-packs/v1",
  "enabled": ["developer-essentials", "semantic-code", "secure-execution"]
}
```

The same change can be made with `system.tool_packs.configure`. Initialized MCP clients receive `notifications/tools/list_changed` and can refresh the catalog without restarting the Gateway.

## Tools

| Tool                    | Level | Purpose                                                                                       |
| ----------------------- | ----: | --------------------------------------------------------------------------------------------- |
| `secrets.refs.list`     |    L1 | List non-secret credential-reference metadata.                                                |
| `secrets.refs.register` |    L2 | Register or update a fixed dynamic source reference; plaintext values are rejected by schema. |
| `secrets.refs.remove`   |    L3 | Remove Sovereign metadata without deleting the source credential.                             |
| `sandbox.capabilities`  |    L1 | Verify installation, executable identity, version, authentication and enforced profile.       |
| `sandbox.list`          |    L1 | List only sandboxes owned by Sovereign for the active workspace.                              |
| `sandbox.create`        |    L2 | Create an offline clone-mode shell sandbox with bounded CPU and memory.                       |
| `sandbox.exec`          |    L2 | Run one bounded Bash command inside the private clone.                                        |
| `sandbox.collect`       |    L2 | Fetch committed sandbox branches into isolated host Git refs without changing the worktree.   |
| `sandbox.stop`          |    L2 | Stop a managed sandbox while preserving sandbox-local state.                                  |
| `sandbox.remove`        |    L3 | Permanently remove a managed microVM and its private clone.                                   |

## Credential-reference boundary

The reference registry accepts only these source kinds:

- `github-cli`, restricted to the `github` service;
- a bounded `op://vault/item/field` 1Password reference;
- a bounded AWS Secrets Manager secret ARN.

The public list and registration results contain only:

- opaque Sovereign ID;
- operator label;
- target service;
- source kind and generic display name;
- created and updated timestamps.

The original `op://` path or AWS ARN is never returned by an MCP tool. No Sovereign tool returns a credential value. Non-GitHub references are protected through the desktop shell's Windows protected-storage boundary before they are written under the Runtime user-data security directory; the JSON registry contains only protected ciphertext plus public metadata. A protected-storage failure rejects registration rather than falling back to plaintext. Trusted in-process integrations may restore a reference just in time, and a changed protected encoding is atomically rewrapped on the next trusted resolution.

This is the credential-reference foundation, not a generic password vault. Provider-specific OAuth flows, secret-value resolution and injection are reserved for reviewed integrations and must never add a `secret.readValue`-style Agent tool. GitHub CLI references store no URI at all and identify only the locally authenticated GitHub CLI account.

## Sandbox isolation profile

Every managed sandbox uses:

- Docker Sandboxes microVM isolation;
- `shell` agent mode;
- `--clone`, never direct writable host-workspace mode;
- a read-only host repository source mounted by Docker Sandboxes;
- a separate writable clone inside the microVM;
- `--deny-network "**"`, which adds a sandbox-scoped deny-all rule;
- no published ports;
- no host environment-variable injection;
- no host-path copy operation;
- committed-work collection only through the provider-managed loopback Git daemon, with no checkout, merge, stage or working-tree mutation;
- no host-side shell invocation;
- no `--privileged` execution flag;
- bounded process time and combined output size.

Clone mode intentionally allows Docker Sandboxes to manage a `sandbox-<name>` remote in the host repository's Git configuration. `sandbox.collect` uses only that exact local remote entry, rejects Git include/URL-rewrite configuration, requires a credential-free `git://` URL on `127.0.0.1`, `localhost` or `::1`, and fetches at most 64 committed branch refs with `--atomic`. Collected branches are written to stable `refs/sovereign/sandboxes/<sandbox-id>/branches/<branch-sha256>` refs; stale refs are removed with compare-and-swap against their previously observed object IDs. The returned result maps those opaque refs back to bounded branch names and commit IDs. The host working tree remains unchanged. Because Docker clone mode cannot resolve a linked worktree `.git` pointer safely, Sovereign rejects sandbox creation and collection from linked Git worktrees and requires the main repository checkout.

A local or organization allow rule cannot override the explicit sandbox-scoped deny-all rule because Docker network deny rules take precedence. The sandbox can still access its isolated filesystem and private Docker daemon, but external TCP, UDP and ICMP access remains unavailable under this profile.

## Ownership and persistence

Sovereign generates a random sandbox ID and a bounded provider name. The private registry stores only sandboxes created through this manager, bound to a SHA-256 fingerprint of the authorized workspace path.

- `sandbox.list` hides unmanaged user sandboxes.
- `sandbox.exec`, `sandbox.collect`, `sandbox.stop` and `sandbox.remove` reject unknown or cross-workspace IDs.
- Registry and executable paths must remain outside the authorized workspace, including after canonical junction/symlink resolution.
- Registry writes use a same-directory temporary file and atomic replacement.
- If registry persistence fails after provider creation, Sovereign removes the newly created sandbox as rollback.
- A long `sandbox.exec` does not hold the registry mutation queue; `sandbox.stop` can intervene while a command is active.
- `sandbox.collect` fences stop/removal until its Git ref update settles; collection never copies uncommitted or untracked files.
- `sandbox.remove` is fenced and rejected while commands or collection remain active, preventing deletion races.
- Returned `commandLabel` values contain only the sandbox name and command SHA-256, never the command body.
- Credential and sandbox mutations write success, denial, and failure receipts into the Runtime's single audit ledger. Collection receipts contain only sandbox/collection IDs and ref counts; branch names, remote URLs, reference URIs, command bodies, stdout and stderr are excluded.

## Current limitations

- Docker account sign-in is required before list/create/execute operations. `sandbox.capabilities` remains usable before sign-in and reports `trusted`, `compatible`, `authenticated`, and `loginRequired` separately.
- The initial profile is intentionally offline. Network allow-list management is not exposed.
- `sandbox.collect` preserves only committed Git branches. Uncommitted changes, untracked files, ignored build outputs and arbitrary filesystem paths are intentionally not copied to the host; commit them first if they must survive sandbox removal.
- Credential references are not yet injected into sandboxes or remote integrations; registration and protected-at-rest storage do not imply provider authorization.
- Docker Sandboxes is an external proprietary runtime. Sovereign trusts only the reviewed executable version and SHA-256 listed above, and local `sbx login` remains an explicit operator action.

## Verification

Automated coverage verifies:

- exact executable version and streaming SHA-256 trust;
- separate trusted, compatible, authenticated and unauthenticated capability states;
- strict JSON-list schema handling and fail-closed schema drift;
- main-checkout-only clone mode;
- exact `--clone`, CPU, memory and deny-all create arguments;
- loopback-only committed-work collection, Git include/URL-rewrite rejection, bounded branch cardinality, atomic fetch, stable hashed refs, stale-ref CAS cleanup and commit-object verification;
- absence of environment, privileged and port-publication flags;
- owned-only list, execute, stop and removal operations;
- stop intervention during active execution and destructive-removal fencing;
- registry and executable placement outside the workspace;
- protected-at-rest references, protected-storage failure closure and ciphertext rewrapping;
- metadata-only public credential results and provider/source compatibility;
- unified redacted audit receipts with no reference URI, command body, stdout or stderr;
- live tool-pack enable and disable through an initialized MCP session.

Release validation additionally probes the real installed `sbx.exe`. Sandbox creation and command execution require a local `sbx login` and should be exercised only after the operator has completed that browser-based sign-in.
