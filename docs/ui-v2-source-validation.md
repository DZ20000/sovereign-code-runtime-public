# UI v2 source and release validation

This guide describes the source boundaries and release evidence for the shared desktop UI. The editable Figma catalog remains the design source; follow the [design workflow](ui-design-workflow.md) before changing a visible surface.

## Implementation boundaries

| Surface | Source responsibility |
| --- | --- |
| Home & Connections (概览与连接) | The shared renderer shell and connection controllers present host state, ChatGPT configuration and the independent Gemini listener. Host-wide MCP activity is not proof that a particular client has connected. |
| Tasks and runs | `tasks-controller.ts` retains task conversation, reported progress, history and project selection. `task-detail-panels.ts` hosts the single run workbench. `runs-controller.ts` owns run selection, output and cancellation. |
| Task/run association | `task-run-scope.ts` accepts an explicit `taskId` or `metadata.taskId`. Conflicting IDs do not associate a run. Workspace paths and titles are not join keys. All runs remain reachable, including historical unassociated runs. |
| Settings | `view-settings.ts` groups General and appearance, Workspace and permissions, and Advanced and diagnostics. Internal section keys remain `appearance`, `security` and `diagnostics`. Task project selection remains in Tasks; permission editing links to the unique Settings form with the actual workspace scope. |
| Approvals and audit | The approval center and independent approval window share the existing approval lifecycle. Audit records describe completed operations; they are not reversible snapshots. |

Progress percentages and steps require explicit reported progress. A task message is plain text; the interface does not imply attachment upload, an automatic planner or a desktop task-creation API. Cancelling a run does not cancel an entire task registry entry.

## Source-only checks

Run from the verified checkout root:

```powershell
node --test scripts/public-source-check.test.mjs
node scripts/public-source-check.mjs --root .
pnpm audit:source-structure
pnpm exec vitest run tests/integration/source-structure-audit.test.ts apps/desktop-tauri/test/source-provenance.test.ts --reporter=dot
pnpm --filter @sovereign/desktop-tauri run test:portable-release
```

These commands do not build or launch the desktop product. Tests use disposable repositories or small temporary ZIP fixtures; the Windows ZIP tests exercise real archive creation.

The privacy scanner reads current file contents and includes non-ignored untracked additions. It checks file paths, recognizable credential material and UTF-8/UTF-16LE content. Additional machine-specific deny terms must remain outside public source and evidence; report finding paths and rule names, never matching values.

The structure guard reads current contents of Git-indexed source files. Before commit, also review untracked source and pending deletions: new files are outside that guard until indexed, and deleted indexed files produce missing-path findings. On the committed CI checkout, all shipped source is indexed. Both `tokens.css` and `v2.css` use the normal CSS limits; there is no UI-specific allowance. Remove baseline entries for retired files and preserve every remaining ceiling.

The [Windows source workflow](../.github/workflows/source-check.yml) additionally runs the actual-tree structure guard, typing, native and Rust checks, regression tests and dependency audits. Fixture tests for a guard do not replace running the guard on the release tree. See [development validation](development.md) for the complete build and test responsibilities.

## Frontend resources in Portable

The main shared renderer imports `tokens.css` and `v2.css`; the latter references the UI SVG assets. Tauri's main and approval entries use the shared renderer. Its build runs `build:web` and embeds the configured `frontendDist` in the desktop executable.

CSS and SVG resources therefore travel through the frontend build into `SovereignCodeRuntime.exe`. They are not separate ZIP components and must not be added as an unrestricted source-directory copy. A source reference check establishes that imports and asset files exist; only a rebuilt executable and rendered smoke check establish that the final package contains and displays them.

The public archive retains its explicit runtime-component and notice allowlists. It excludes profiles, pairing/settings files, smoke reports and private design-account bindings. The release wrapper remaps build paths, verifies the source commit and component hashes, scans the archive, and writes the ZIP checksum.

## Evidence required for release

- Record the final public commit and confirm a clean source tree before packaging.
- Confirm the root product, Tauri package/configuration, Cargo package/lock entry, Gateway and Runtime Host use the intended product version. Internal workspace package versions have a separate purpose.
- Require successful source, Android and dependency-audit jobs for the exact release commit; a version tag must identify a commit already merged into the public main branch.
- Keep isolated visual results for the implemented routes, both languages, keyboard operation, narrow layouts and important error states.
- Build the public Portable from that commit, verify its manifest and checksum, and inspect the final archive with the public privacy scanner.
- Distinguish source checks, isolated visual checks, packaged smoke and an actual installed application. Passing one does not establish the others.

Public validation notes may contain commands, commit IDs, aggregate results, relative finding paths and rule names. They must not contain local account paths, usernames, hostnames, credentials, private design keys, personal conversations or live profile data.
