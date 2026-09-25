# Stable capability catalog

Sovereign exposes a small stable public facade for capability discovery and bounded read-only dispatch. The facade reduces repeated ChatGPT Action-schema churn for low-frequency read capabilities while preserving the Runtime's native ToolSpec, policy, approval, workspace-containment, and audit checks.

## Stable public tools

Five core tools are always present:

| Tool                    | Purpose                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `capabilities.search`   | Search active tools by text, category, pack, permission level, and facade eligibility with a manifest-bound cursor. |
| `capabilities.describe` | Return one active tool's schema, current connection authorization, remaining local approval, pack ownership, and facade eligibility. |
| `capabilities.execute`  | Dispatch only an approved L1 read capability through the current ToolCatalog.                                       |
| `capabilities.snapshot` | Return the live manifest digest, tool count, pack generation, category counts, and stable facade names.             |
| `client.catalog_status` | Compare a client-provided action snapshot with the live Runtime catalog.                                            |

`client.catalog_status` does not claim that Sovereign can inspect an opaque ChatGPT application-approval cache. The client must provide any manifest digest, tool count, or pack generation it wants compared.

## Authorization and confirmation

`capabilities.describe.runtimeAuthorization` reports the current external connection's bound workspace, live permission profile, profile eligibility, principal policy denial (if any), and remaining Sovereign local approval. It reads existing authorization without prompting, granting access, or executing the target. Desktop/internal descriptions return `null` because their controller owns approval before catalog invocation.

- `blocked`: the current profile or principal policy does not permit the tool.
- `not-required`: Sovereign does not require another local prompt under the current profile.
- `broker-required`: the current L3 profile requires a local broker decision for this consequential call. This query does not ask the broker or predict whether its current policy will show a prompt.
- `unavailable`: local approval is required but no broker is available.

The top-level `approvalMode` is static tool metadata, not evidence that a new prompt is required. L2 workspace operations reuse the external workspace profile; an already authorized L4 profile requires no additional Sovereign prompt. No permission setting changes when reading this description. The result is a snapshot, not a reservation: actual execution still validates the input, current policy, resource ownership, and path containment.

`taskScope: "not-inferred"` means runtime access does not establish the user's task authorization. Reuse the existing user instructions and delegated scope for work already authorized; ask only about a new consequence or missing required input. Do not treat a broad capability grant as authorization for unrelated work or other directories.

`clientApproval: "independent"` means ChatGPT/client approval remains separate and cannot be read or overridden by Sovereign. If that layer rejects a call, retain its exact reason, identify that layer, and report the smallest permitted next step. Do not retry the same rejected action through another tool, identity, encoding, or permission downgrade. If the client rejected the call before dispatch, the absence of a Sovereign rejection receipt is expected.

Sovereign's local broker currently returns a boolean to the Gateway. A false result reports `layer: "sovereign.local-approval"` and `reason: "approval-not-granted"`; it does not prove the user explicitly denied the request, since cancellation and expiry also return false. Detailed local lifecycle reasons remain in the approval broker's event history. An unavailable broker reports `reason: "broker-unavailable"`.

## Read-only execution boundary

`capabilities.execute` is intentionally narrower than the full ToolCatalog. A target must be:

- currently active;
- `permissionLevel: "observe"`;
- non-destructive;
- in the reviewed `system`, `workspace`, `files`, `search`, `git`, `runs`, or `code` category set;
- outside the stable facade itself;
- outside task messaging, Terminal, Python, browser, computer-use, and workflow namespaces.

Typical eligible targets include:

```text
files.read_lines
workspace.context
git.show
git.branches
runs.follow
code.symbol.find
code.diagnostics
```

These operations always require dedicated Actions and are rejected by the facade:

```text
files.replace_text
tasks.message.send
terminal.start
python.start
browser.navigate
computer.action
workflow.start
system.tool_packs.configure
```

The target call is routed back through the same external or internal `ToolCatalog` that received the facade call. Target schema validation, principal capabilities, workspace grants, external permission profile, and local approval remain authoritative. The facade never calls a target handler directly.

## Search cursors and catalog changes

Search cursors contain an opaque fingerprint derived from:

- the live manifest digest;
- the normalized query;
- category and pack filters;
- permission filter;
- facade-executable filter.

A cursor becomes invalid after a tool-pack or manifest change. This prevents continuation against a different catalog generation.

Pack ownership is derived from the live `system.tool_packs` registry. Active core tools report no pack; active pack tools report the pack ID, version, and title. Disabled packs remain visible in `capabilities.snapshot.toolPacks`, but their tool schemas are not returned as active capabilities.

## Audit model

Every successful or failed `capabilities.execute` call writes a bounded audit receipt containing:

- principal ID;
- target tool name;
- manifest digest;
- canonical input byte length;
- SHA-256 of canonical input;
- outcome and bounded error metadata.

Raw target input and raw target error text are not written to the dispatch audit receipt. A target tool can also produce its normal domain-specific audit receipt.

## Client refresh workflow

For an MCP client that supports dynamic tool lists:

```text
Tool pack changes
→ notifications/tools/list_changed
→ tools/list
→ capabilities.snapshot or client.catalog_status
```

For a ChatGPT App with a frozen or approval-gated Action snapshot:

```text
Tool pack changes
→ Sovereign catalog updates immediately
→ existing stable facade remains callable
→ newly public dedicated Actions may still require Refresh Actions and approval
```

The stable facade reduces refresh pressure for approved read-only capabilities; it does not bypass ChatGPT approval for high-risk Actions.

## Verification

Automated coverage verifies:

- query filtering and cursor pagination;
- stale cursor rejection after catalog changes;
- pack ownership and active-only description;
- read-only target dispatch through the original ToolCatalog;
- rejection of mutations, task tools, Terminal, and recursive facade targets;
- input and error hashing without raw values in audit receipts;
- live semantic-pack discovery and execution;
- explicit client snapshot match and mismatch reporting.
