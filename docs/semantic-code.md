# Semantic code intelligence

Sovereign can expose a reviewed read-only subset of Serena's language-server tools through the optional `semantic-code` pack. The pack is disabled by default because Serena is an external executable rather than part of the Runtime Host bundle.

## Install Serena

The supported local installation uses `uv` and Python 3.13:

```powershell
uv tool install -p 3.13 'serena-agent==1.7.0'
serena --version
```

The Gateway resolves `serena` from the Runtime Host environment. The standard runtime verifies `serena --version` against the reviewed `1.7.0` release before starting the MCP sidecar and fails closed on a mismatch. An embedding application may instead pass an explicit `serenaExecutablePath` and, where appropriate, an explicit `serenaExpectedVersion` to `startGatewayRuntime`.

## Enable the pack

Keep the default developer tools and add the semantic pack:

```json
{
  "schemaVersion": "scr.tool-packs/v1",
  "enabled": ["developer-essentials", "semantic-code"]
}
```

The same change can be performed through:

```text
system.tool_packs.configure
```

with:

```json
{
  "enabled": ["developer-essentials", "semantic-code"]
}
```

Existing initialized MCP clients receive `notifications/tools/list_changed` and can refresh their catalog without restarting the Gateway.

## Sovereign tools

| Sovereign tool         | Serena operation           | Notes                                                          |
| ---------------------- | -------------------------- | -------------------------------------------------------------- |
| `code.semantic.status` | connection probe           | Starts Serena lazily and reports only bounded status metadata. |
| `code.symbols`         | `get_symbols_overview`     | Compact symbols for one file.                                  |
| `code.symbol.find`     | `find_symbol`              | Name-path lookup, optionally scoped to a path.                 |
| `code.references`      | `find_referencing_symbols` | References to an identified symbol.                            |
| `code.implementations` | `find_implementations`     | Implementations of an identified symbol.                       |
| `code.definition`      | `find_declaration`         | Declaration resolution from one bounded source usage pattern.  |
| `code.diagnostics`     | `get_diagnostics_for_file` | Bounded file diagnostics.                                      |

No Serena editing, memory, shell, project mutation, onboarding, activation, or arbitrary file tool is exposed.

## Process and storage boundary

For each authorized workspace, Sovereign creates a private Serena profile under the Runtime user-data directory, never beneath the workspace. `USERPROFILE` and `HOME` for the Serena child process are redirected to that profile. The generated configuration:

- disables the web dashboard and GUI log window;
- disables LSP tracing;
- redirects Serena project metadata, indexes, logs, and caches outside the workspace;
- excludes `.git`, dependency, generated, artifact, research, and worktree directories;
- fixes the upstream MCP catalog to exactly six reviewed read-only tools;
- trusts only the current authorized workspace path;
- applies bounded tool timeouts and answer-size limits.

At connection time Sovereign lists the upstream Serena tools and compares the names against the exact allowlist. A missing, additional, or renamed tool causes the semantic sidecar to fail closed.

Every path sent to Serena is separately checked for:

- relative-path form;
- traversal, drive, UNC, device, and alternate-stream syntax;
- symbolic-link targets;
- lexical workspace containment;
- canonical workspace containment after resolving junctions.

The semantic sidecar is stopped when the `semantic-code` pack is disabled and during normal Runtime shutdown. Re-enabling the pack does not start a process immediately; the next semantic call starts a fresh reviewed sidecar. Serena remains a descendant of the Runtime Host process for guardian recovery.

## Current limitations

This integration is a read-only productivity layer, not an operating-system sandbox. Serena and the language servers it launches still execute as local processes with the current user account. Do not enable the pack for untrusted repositories until the planned sandbox execution layer is available.

Semantic analysis also depends on the language servers supported by the installed Serena version and the project's build configuration. A successful `code.semantic.status` proves the reviewed MCP surface is connected; it does not guarantee that every language in a mixed repository has an initialized language server.

## Verification

Automated tests cover:

- exact six-tool upstream allowlisting;
- rejection of an upstream editing tool;
- profile placement outside the workspace;
- canonical path validation;
- result-size limits and bounded status output;
- live pack enable/disable through the Gateway catalog;
- removal of semantic tools after the pack is disabled;
- absence of a workspace-local `.serena` directory.

Release validation should additionally run a real Serena smoke against representative source files and verify `code.symbols`, `code.symbol.find`, and `code.diagnostics` before installation.
