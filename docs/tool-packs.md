# Tool packs and live catalog reload

Sovereign supports a bounded, declarative tool-pack registry. The registry can enable or disable reviewed tool definitions while the Gateway is running. It does not load arbitrary JavaScript, Python, PowerShell, executable paths, or package names from configuration.

## Bootstrap and reload model

Installing the live-reload implementation itself still requires one normal build and application restart because the running Runtime Host must load the new catalog manager. After that bootstrap restart, changing the tool-pack configuration does not require restarting the Runtime Host, Gateway, or existing MCP sessions.

For every accepted configuration change, Sovereign:

1. reads at most 64 KiB as strict UTF-8;
2. validates the versioned JSON document and rejects unknown or duplicate pack identifiers;
3. constructs and validates the complete next definition set before publication;
4. atomically replaces both the external ChatGPT catalog and the internal desktop catalog;
5. updates the manifest digest and generation;
6. sends the standard MCP `notifications/tools/list_changed` notification to initialized sessions;
7. writes a bounded audit receipt containing pack identifiers and manifest metadata, but no file contents.

`fs.watch` provides the fast path and a bounded polling loop provides a fallback for editors that replace files atomically. An invalid configuration leaves the last valid catalogs active.

A connected MCP client that implements `tools.listChanged` can refresh without reconnecting. A host that intentionally freezes application actions, including some ChatGPT application publication flows, can still require an explicit action rescan in that host even though the Sovereign session remains live.

## Configuration

The Runtime creates `tool-packs.json` beside its audit database when the file does not yet exist. Embedders can supply an explicit `toolPackConfigPath` to `startGatewayRuntime`.

The document shape is:

```json
{
  "schemaVersion": "scr.tool-packs/v1",
  "enabled": ["developer-essentials"]
}
```

A repository example is available at [`config/tool-packs.example.json`](../config/tool-packs.example.json).

Removing a pack identifier disables all tools owned by that pack. Restoring the identifier re-enables them. Core tools and the three pack-management tools are not controlled by this file.

The same change can be made through `system.tool_packs.configure`, which accepts the exact desired set of reviewed pack IDs, persists a canonical registry document, and publishes the resulting catalog in the same serialized reload transaction.

## Management tools

Three core tools are always present:

| Tool                          | Level | Purpose                                                                                                                      |
| ----------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------- |
| `system.tool_packs`           |    L1 | Read the installed pack registry, active generation, manifest digest, tool count, and last reload result.                    |
| `system.tool_packs.reload`    |    L2 | Re-read the configuration immediately. Ordinary file changes are already detected automatically.                             |
| `system.tool_packs.configure` |    L2 | Persist and activate the exact set of installed, reviewed pack IDs. Unknown IDs are rejected before the registry is changed. |

The public status reports only the configuration filename, not the absolute user-data path.

## Installed pack: developer-essentials

The first reviewed pack is enabled by default and adds thirteen tools:

| Tool                       | Level | Purpose                                                                                     |
| -------------------------- | ----: | ------------------------------------------------------------------------------------------- |
| `system.capabilities`      |    L1 | Combine bounded Windows, Python, browser, and computer-use capability reports.              |
| `files.read_lines`         |    L1 | Read a bounded line-numbered window from one contained UTF-8 file with its current SHA-256. |
| `workspace.context`        |    L1 | Return cursor-paginated branch, dirty-file, matching-path, and bounded snippet context.     |
| `workspace.snapshot`       |    L1 | Return a bounded workspace tree together with local Git status.                             |
| `git.summary`              |    L1 | Return bounded status, recent history, and staged or unstaged diff data.                    |
| `git.show`                 |    L1 | Read a validated revision diff or stat, optionally limited to one contained path.           |
| `git.blame`                |    L1 | Read a bounded line-porcelain authorship window for one contained tracked file.             |
| `git.branches`             |    L1 | List bounded local and optional remote branch metadata ordered by latest commit.            |
| `git.tags`                 |    L1 | List bounded tag metadata ordered by creator date.                                          |
| `git.worktrees`            |    L1 | Read the Git worktree registry in bounded porcelain form.                                   |
| `git.files`                |    L1 | List tracked files and optionally untracked non-ignored files beneath a contained path.     |
| `validation.verify`        |    L2 | Start the fixed typecheck-and-test workflow as a cancellable run.                           |
| `validation.release_check` |    L2 | Start the fixed typecheck, test, and build workflow as a cancellable run.                   |

These tools compose existing Windows Adapter operations. They do not introduce a second filesystem, process, policy, approval, or audit implementation.

## Optional pack: semantic-code

The `semantic-code` pack is installed but disabled by default. After Serena is installed locally, enable it together with the developer pack:

```json
{
  "schemaVersion": "scr.tool-packs/v1",
  "enabled": ["developer-essentials", "semantic-code"]
}
```

It adds seven read-only tools:

| Tool                   | Level | Purpose                                                                    |
| ---------------------- | ----: | -------------------------------------------------------------------------- |
| `code.semantic.status` |    L1 | Start or probe the isolated Serena sidecar and report its exact allowlist. |
| `code.symbols`         |    L1 | Return a compact semantic symbol overview for one contained source file.   |
| `code.symbol.find`     |    L1 | Find symbols by Serena name-path pattern.                                  |
| `code.references`      |    L1 | Find semantic references to a named symbol.                                |
| `code.implementations` |    L1 | Find semantic implementations of a named symbol.                           |
| `code.definition`      |    L1 | Resolve a declaration from one bounded source usage pattern.               |
| `code.diagnostics`     |    L1 | Return bounded LSP diagnostics for one contained source file.              |

Sovereign writes an isolated Serena profile outside the authorized workspace, disables dashboards and GUI logging, and fixes the sidecar tool list to six upstream read operations. If Serena exposes an extra tool—especially an editing operation—the sidecar fails closed. Normal semantic results are capped, paths are revalidated against the canonical workspace, and Serena is started lazily only after a semantic tool is called. See [`semantic-code.md`](semantic-code.md).

## Optional pack: secure-execution

The `secure-execution` pack is installed but disabled by default. It adds nine tools for metadata-only credential references and reviewed Docker Sandboxes operations:

| Tool                    | Level | Purpose                                                                         |
| ----------------------- | ----: | ------------------------------------------------------------------------------- |
| `secrets.refs.list`     |    L1 | List non-secret reference metadata.                                             |
| `secrets.refs.register` |    L2 | Register a fixed GitHub CLI, 1Password or AWS Secrets Manager source reference. |
| `secrets.refs.remove`   |    L3 | Remove Sovereign metadata without deleting the provider credential.             |
| `sandbox.capabilities`  |    L1 | Verify installation, version, executable hash, sign-in and isolation profile.   |
| `sandbox.list`          |    L1 | List Sovereign-owned sandboxes for the active workspace.                        |
| `sandbox.create`        |    L2 | Create a clone-mode, network-denied microVM with bounded resources.             |
| `sandbox.exec`          |    L2 | Execute a bounded Bash command inside the private clone.                        |
| `sandbox.stop`          |    L2 | Stop a managed sandbox while retaining its state.                               |
| `sandbox.remove`        |    L3 | Permanently remove a managed microVM and clone.                                 |

The pack trusts only reviewed Docker Sandboxes `sbx` 0.39.0 and its pinned Windows x64 executable SHA-256, then separately validates CLI JSON compatibility and local sign-in. Sandbox creation uses the main Git checkout, `--clone`, a sandbox-scoped `--deny-network "**"` rule, no published ports, no host credential environment, and no host-path copy surface. Non-GitHub reference URIs are protected through the desktop protected-storage boundary before persistence; credential values and raw reference URIs are never returned by MCP. Mutations write redacted receipts to the Runtime audit ledger, and long command execution does not block `sandbox.stop`. See [`secure-execution.md`](secure-execution.md).

## Stable capability facade

Five core Actions remain stable while reviewed packs are enabled or disabled:

```text
capabilities.search
capabilities.describe
capabilities.execute
capabilities.snapshot
client.catalog_status
```

The facade can search and describe every active tool, but `capabilities.execute` dispatches only non-destructive L1 capabilities in a reviewed read-only category set. Pack mutations, task messaging, Terminal, Python, browser, desktop control, and workflows still require dedicated Actions. Search cursors are bound to the live manifest digest and become invalid after a catalog generation changes. See [`capability-catalog.md`](capability-catalog.md).

## Security boundary

A tool pack is compiled into the trusted Runtime Host bundle. The JSON registry only chooses among known pack IDs. Therefore a workspace file, renderer script, connected Agent, or malformed registry cannot point Sovereign at an arbitrary module or command and have it loaded as a trusted tool.

Adding a new pack requires normal source review and a build. Enabling, disabling, or switching among packs already present in that build is live. External MCP sidecars require a separate trust, version-pinning, process-isolation, credential, and policy design and are not implicitly authorized by this mechanism.

## Verification

The automated coverage verifies:

- atomic catalog replacement and duplicate-name rejection;
- default pack installation;
- synchronized external and internal catalogs;
- automatic file-watcher reload;
- explicit pack configuration with unknown-ID rejection;
- invalid-configuration rollback and repeated read-error deduplication;
- authenticated manifest updates;
- removal enforcement for calls made through an already initialized MCP client;
- delivery of `notifications/tools/list_changed` to an already initialized MCP client;
- stable capability search, active-only description, manifest-bound cursor invalidation, and explicit client snapshot comparison;
- read-only facade dispatch through the original ToolCatalog with task, Terminal, browser, computer, Python, workflow, mutation, and recursive-target rejection;
- input and error hashing without raw values in capability-dispatch audit receipts;
- lazy semantic-pack enablement and removal without a Gateway restart;
- exact Serena read-only tool allowlisting and fail-closed rejection of extra tools;
- semantic profile/caches outside the workspace and canonical path containment;
- live secure-pack enablement through an initialized MCP session;
- protected-at-rest credential references, metadata-only public results, and fixed provider/source compatibility;
- redacted unified audit receipts for credential and sandbox mutations;
- exact Docker Sandboxes version/hash trust, separate CLI compatibility and authentication states, clone-mode arguments, deny-all networking and owned-only lifecycle operations;
- stop intervention during active execution and fenced destructive removal.
