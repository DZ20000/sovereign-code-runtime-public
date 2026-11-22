# Workspace instructions and skills

Sovereign exposes three read-only MCP tools for project instructions and skills:

| Tool | Purpose |
| --- | --- |
| `workspace.instructions` | Read applicable `AGENTS.md` files, ordered from the authorized workspace root to the target directory. |
| `skills.list` | Discover `SKILL.md` files beneath configured relative roots, with names, hashes and short text previews. |
| `skills.read` | Read a selected skill in full, optionally checking the hash returned by discovery. |

All three require the existing `workspace.read` and `files.read` capabilities. They are available at the `observe` permission level. They do not execute instructions, install skills, run commands, change permissions, or register additional directories. Returned project text remains project-provided context.

## Find applicable AGENTS.md files

Call `workspace.instructions` with an existing workspace-relative file or directory:

```json
{
  "path": "src/components/view.ts",
  "maxFileBytes": 65536,
  "maxBytes": 262144
}
```

For an existing file, its parent directory is the target directory. For a directory, that directory is the target. An empty path selects the workspace root. A nonexistent target is rejected; for work on a new file, request its existing parent directory.

Only the following ancestor chain is considered in this example:

1. `AGENTS.md`
2. `src/AGENTS.md`
3. `src/components/AGENTS.md`

Missing instruction files are skipped. Siblings and parents above the registered workspace root are not examined. Results include:

- The actual `workspaceId`, normalized target path and target directory.
- `order: "root-to-leaf"`.
- Each document's relative path, applicable directory, original byte count, SHA-256 and complete text. An empty `appliesTo` denotes the workspace root.
- `complete` and `diagnostics`.

The ordering describes where the text came from. Sovereign does not promote a deeper document into system authority or interpret project instructions as authorization.

The default per-file limit is 64 KiB; it may be raised to 256 KiB. The total result is bounded by its UTF-8 JSON size, with a default and maximum of 256 KiB. At most 64 target path segments are supported. A document that cannot fit is omitted in full and reported in diagnostics: its text is never silently shortened and presented as a complete instruction.

**Check `complete` before relying on the result.** A rejected path, oversized document or response limit produces an incomplete result with a path and code. If even the diagnostic metadata cannot fit, the request fails with `FILE_TOO_LARGE`. Missing files alone do not make the chain incomplete.

## Discover and select a skill

The default roots, in priority order, are:

```text
.agents/skills
.codex/skills
skills
```

Call `skills.list` without a root to examine those configured roots:

```json
{
  "maxSkills": 50,
  "maxDepth": 3,
  "maxBytes": 65536
}
```

Every skill includes:

- `name`: its directory name, not a claim about a YAML field.
- `root` and `relativePath`: its source and stable identity.
- `bytes` and `sha256`: metadata for the complete file.
- `preview`: `{ type: "text", text, truncated }`, containing at most 600 Unicode code points from the trimmed document.

The preview is plain document text. YAML frontmatter may appear verbatim in it; Sovereign does not claim to parse YAML names, descriptions, folded values, aliases or other frontmatter features. A truncated preview is for selection and is not a replacement for reading the skill.

Complete discovery results are sorted by configured-root order and then by relative path. Identical directory names in different roots remain separate entries. Overlapping roots do not duplicate the same file. A missing root is skipped.

Discovery reads at most 64 KiB per skill, returns at most 200 skills, scans at most 1,000 directory entries across the request and supports a maximum depth of four. The default depth is three: a root-level `SKILL.md` is depth one, and `.codex/skills/.system/example/SKILL.md` is depth three below its configured root. The default JSON response budget is 64 KiB, with a maximum of 256 KiB.

When a limit or unreadable path is encountered, `complete` is false and diagnostics explain which path was affected. A large unrelated directory can consume the scan budget. Select one exact configured `root` to narrow discovery, increase a permitted count/depth/response limit, or have the local host configure a more specific root. Tool input cannot authorize a new root.

Read the selected skill with its discovery hash:

```json
{
  "path": ".agents/skills/build/SKILL.md",
  "expectedSha256": "<the 64-character lowercase hash returned by skills.list>",
  "maxBytes": 262144
}
```

`skills.read` accepts only `SKILL.md` beneath a configured root. It returns the complete file within the requested limit, including its current hash. A changed hash fails with `STALE_HASH`. An oversized file fails rather than returning a partial skill. Referenced scripts or supporting documents remain accessible through existing workspace file tools where the caller already has permission; this feature never runs them automatically.

## Configure roots in a trusted host

The Gateway API accepts an optional `skillRootsByWorkspaceId` mapping. Values are arrays of at most eight workspace-relative roots. They replace the defaults for that workspace; an empty array disables skill discovery there.

The mapping is supplied by the local host, not by an MCP call or an instruction file:

```ts
const runtime = await startGatewayRuntime({
  bearerToken,
  workspaceRoot: projectRoot,
  workspaceId: "project",
  externalPermissionProfile: "observe",
  skillRootsByWorkspaceId: {
    project: [".agents/skills", "team/skills"]
  }
});
```

Configuring a root does not register a directory, change a Principal, or grant connection reach. Every path still passes the same workspace policy and path guard.

### Explicit global skills

To share a global skill collection, the operator must explicitly choose a narrow directory containing those skills, register it as a separate workspace, and authorize that workspace for the connection. Do not register the entire home directory as a shortcut.

The API can express this without a separate permission system:

```ts
const runtime = await startGatewayRuntime({
  bearerToken,
  workspaceRoot: projectRoot,
  workspaceId: "project",
  externalPermissionProfile: "observe",
  reachableWorkspaceIds: ["global-skills"],
  skillRootsByWorkspaceId: {
    "global-skills": [""]
  }
});

await runtime.registerWorkspace({
  id: "global-skills",
  root: explicitlySelectedGlobalSkillDirectory,
  externalPermissionProfile: "observe"
});
```

Here `""` means the registered skill workspace's own root. A client can then request `skills.list` with `workspaceId: "global-skills"`. The target workspace's `observe` profile still rejects writes, even if the serving project has a higher permission profile.

Connection reach is fixed by the Gateway's startup configuration. Registering a workspace or adding it to the discovery-root mapping alone does not grant reach. Existing MCP binding falls back to the connection's bound workspace for an unreachable or unknown requested ID; always inspect the actual returned `workspaceId`. A reachable but unregistered ID fails with `WORKSPACE_NOT_FOUND`.

This configuration is currently a host API feature. There is no automatic scan of user-home skill folders and no new global-skills picker or permission prompt in the desktop UI.

## File boundaries and validation

The tools use the existing Windows workspace policy and path guard. Absolute, drive-qualified, UNC, device and parent-traversal paths are rejected. Git metadata is excluded. Symbolic links and junctions are not followed. Opened files must be regular files with one hard link; the canonical path and file identity are checked before and after reading.

Text and image reads share a bounded file-handle reader. It reads at most the limit plus one detection byte, so a file growing after its initial size check cannot cause an unbounded read. Hashes describe the exact bytes read; the text is returned as UTF-8.

Focused validation uses isolated temporary workspaces and an ephemeral local MCP runtime:

```powershell
pnpm typecheck
pnpm --filter @sovereign/desktop run build:native
pnpm exec vitest run apps/gateway/test/workspace-instructions.test.ts packages/windows-adapter/test/image-read.test.ts packages/windows-adapter/test/security.test.ts packages/windows-adapter/test/repository-inspection.test.ts packages/toolkit/test/catalog.test.ts apps/gateway/test/runtime-workspaces.test.ts apps/gateway/test/image-tool-mcp.test.ts
```

The suite covers ancestor order, unchanged full-document hashes, text previews, size and scan budgets, stale reads, traversal, junctions, hard links, concurrent file growth and replacement, MCP schemas, and the independent requirements for global-workspace registration, reach and permission profile. It does not use a real account or a running user service.
