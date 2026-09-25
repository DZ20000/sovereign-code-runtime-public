# Source-structure guard

Sovereign audits Git-tracked source files with a ratcheted line-count policy:

```powershell
pnpm audit:source-structure
```

The command is read-only. It loads `config/source-structure-audit.json`, enumerates source through `git ls-files`, ignores known generated directories, and compares each file with `config/source-structure-baseline.json`.

Use the guard for behavior growth in a large or baselined module, a potentially oversized new file, baseline changes, planned extraction, or a requested structural review. Small wording/comment changes that add no responsibility do not independently require module extraction or a full-repository gate. Existing required checks remain applicable.

## Policy

- 700 lines is the default cohesion-review threshold.
- 1200 lines is the default hard limit for a file without a baseline entry.
- Files already above the hard limit when the guard was introduced have an explicit current ceiling and reason.
- A baseline file may shrink without ceremony. It may not grow beyond its recorded ceiling.
- Once a baseline file falls to the hard limit or below, the audit asks for its baseline entry to be removed. Verify the reduced file and remove that obsolete entry in the same reviewed change; no separate commit is required.
- The CLI refuses `--write-baseline`, `--update-baseline`, and `--ratchet`. A failing change cannot pass by silently raising its own limit.

The baseline does not claim that existing large files are well designed. It records bounded historical debt so the guard can be introduced without an unrelated mass refactor.

## Safe reports

JSON reports use schema `scr.source-structure-audit/v1`. An optional report must be a new, Git-ignored `.json` file below `.sovereign/reports`. Existing reports are never overwritten, and linked report directories are rejected.

## Scope

Only Git-tracked source extensions are inspected. Generated and dependency directories such as `dist`, `target`, `artifacts`, `coverage`, `node_modules`, and visual-test output are excluded. Tracked source links or junctions fail the audit instead of being followed.

## Editing large files

Before adding substantial behavior to a baseline file, identify a cohesive extraction boundary such as model/state, rendering, orchestration, persistence, protocol, or platform adapter. Move its focused tests with it, preserve public behavior, then remove the obsolete duplicate implementation.

Remove stale baseline entries when the associated file has been removed or reduced to the hard limit or below; a reviewed move can carry the unchanged ceiling to the new path. These changes belong in the same review as the source change. Creating or increasing a debt allowance requires explicit architectural review explaining why immediate extraction is riskier. Never raise a line limit to mask growth in the patch that is failing the audit.

## Validation scope

Inspect current audit evidence before choosing a structural change, and rerun the audit after extraction or changes to baseline/source inventory. Reuse a result only while its relevant source inventory, line counts, and configuration remain unchanged. The command inspects tracked source only, so an untracked new file is not covered by a passing report.

Run focused behavior tests for the affected module and typecheck/builds when changed interfaces or required gates warrant them. Documentation-only edits need content, link, or example checks; they do not trigger unrelated builds or repeated full test suites. Keep unresolved pre-existing findings visible without turning the current change into an unrelated refactor.

Never use the current failing change to raise a baseline or a line limit. A `SOURCE_FILE_BASELINE_EXCEEDED` result requires architectural review and is never permission to rewrite the baseline automatically.
