# Required CodeQL checks

The active `main-governance` repository ruleset (ID `24064019`) keeps its original source checks and additionally requires every language job from [CodeQL Advanced](../.github/workflows/codeql-android.yml).

| Exact check context | Expected source |
| --- | --- |
| `source` | Existing source-check rule, unchanged |
| `android-source` | Existing source-check rule, unchanged |
| `full-dependency-audit` | Existing source-check rule, unchanged |
| `Analyze (actions)` | GitHub Actions, App ID `15368` |
| `Analyze (javascript-typescript)` | GitHub Actions, App ID `15368` |
| `Analyze (csharp)` | GitHub Actions, App ID `15368` |
| `Analyze (rust)` | GitHub Actions, App ID `15368` |
| `Analyze (java-kotlin)` | GitHub Actions, App ID `15368` |

These are the emitted check-run names, not workflow filenames or a guessed combined `CodeQL` context. Names and the emitting App ID were verified on public main `9735816c8268e6720a1fef8f6cd09d948a4880d3` and PR #28 head `01329b746f1b6772ac904e2c95ae487778cb5fb5`.

Strict up-to-date checks remain enabled. The ruleset still has no bypass actors and retains its deletion, non-fast-forward, linear-history, pull-request and review-thread requirements. Repository settings are the effective policy; this document alone cannot enforce a rule.

## Maintaining check names

1. Read the current ruleset and retain a before-change snapshot. Read the proposed workflow and its actual check runs on the exact candidate SHA, including the emitting App ID. Use the PR's test-merge SHA when GitHub evaluates that revision.
2. For a planned rename, keep the old required job names available while introducing the new names. Run and verify the new checks before adding them to the ruleset; do not remove a required check just to clear a blocked PR.
3. Update only the intended contexts. Preserve the existing checks, strict policy, other rules and absence of bypass actors. Read the resulting ruleset back and compare it with the planned change.
4. Validate a disposable, documentation-only PR: record the normal merge gate's refusal while required checks are outstanding, then verify every real check on the final revision before using the normal merge endpoint. Do not fabricate successful statuses, disable rules or repeatedly rerun failures until green.
5. Once the transition is verified, retire an obsolete context through a separately reviewed policy change. Record the exact revisions and results in the tracking issue.

## What this gate does not prove

GitHub treats `success`, `neutral`, and `skipped` as satisfying a required status check. A conditionally skipped job therefore is not evidence that analysis ran. Keep all five language jobs unconditional for applicable PRs, and inspect their actual analysis/upload steps during acceptance. A missing workflow, a pending check, a failed check, or a check from the wrong configured App cannot satisfy that required context.

A successful analysis job is not a claim of zero CodeQL findings, complete security review, installation safety or binary-license compliance. Alert triage and any separate code-scanning merge-protection policy remain distinct. App binding identifies the reporting integration; it does not make arbitrary edits to a GitHub Actions workflow trustworthy.

References: [repository rulesets API](https://docs.github.com/en/rest/repos/rules), [required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), and [tracking issue #29](https://github.com/DZ20000/sovereign-code-runtime-public/issues/29).
