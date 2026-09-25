# Generated-artifact inventory

Sovereign provides a read-only inventory for build output, caches, visual captures, dependency trees, prepared Runtime resources, local research output, and worktree containers:

```powershell
pnpm audit:generated-artifacts
```

The command emits `scr.generated-artifact-inventory/v1` JSON. It never removes anything and every entry contains:

```text
automatedDeletionAllowed: false
```

## Dispositions

- `eligible-after-process-check`: Git-ignored, untracked, complete evidence for regenerable output. A future cleanup still has to re-check active processes and Task ownership immediately before removal.
- `review`: dependency caches, prepared build inputs, local research, links, inaccessible entries, incomplete scans, or paths not confirmed Git-ignored.
- `blocked`: tracked content and `.worktrees`. These are never ordinary generated output.

Observed byte totals are exact only for entries with `complete: true`. A bounded traversal that exhausts its entry budget is explicitly marked incomplete and review-only.

## Safety boundary

The inventory:

- refuses filesystem and volume roots;
- must run from the exact Git worktree root;
- loads tracked paths from Git and blocks candidates containing tracked content;
- does not follow symbolic links or junctions, and treats hard-linked candidate files as review-only;
- deliberately does not traverse `.worktrees`;
- refuses `--delete`, `--remove`, `--clean`, and `--prune`;
- contains no filesystem deletion primitive;
- writes only new, Git-ignored JSON reports under `.sovereign/reports`.

A report is evidence, not cleanup authorization. It can become stale as soon as a build, test, install, Task, or worktree changes.

## Candidate classes

The default inventory recognizes `dist`, `build`, `out`, `target`, `artifacts`, visual-test output, coverage, build caches, dependency caches, `runtime-resources`, `.local-research`, `.so-automation`, logs, temporary files, backups, and `.worktrees`.

`runtime-resources` is intentionally review-only: it may be generated, but Rust or release packaging can depend on it. A cleanup must prove the documented regeneration command first.

## Persisting a report

```powershell
node scripts/generated-artifact-inventory.mjs `
  --root . `
  --output .sovereign/reports/generated-artifacts.json `
  --max-entries 100000
```

The destination must not already exist. No overwrite mode is provided.
