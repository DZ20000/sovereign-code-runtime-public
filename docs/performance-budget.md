# Performance budget

Updated: 2026-08-12

## Purpose

Sovereign measures desktop-shell resource cost with the same `scr.resources/v1` schema across the legacy Electron shell and the primary Tauri 2 / WebView2 shell. These are project engineering measurements, not industry standards.

The runtime is now a separate Node Runtime Host sidecar in both shells, so shell comparisons no longer depend on an Electron-embedded Gateway.

## Measurement protocol

Matched comparison entry point:

```text
pnpm benchmark:desktop
```

The comparison runner launches packaged Electron and packaged Tauri executables on the same Windows machine, with the same repository workspace and isolated temporary user-data directories. Tunnel is not required for the benchmark. Each scenario stabilizes for 10 seconds and then captures five resource snapshots two seconds apart.

Current matched scenarios:

```text
R0-shell       desktop shell + Runtime Host, no authorized workspace/runtime
R1-runtime     authorized workspace + loopback Gateway/runtime running
```

Reports are written below:

```text
apps/desktop-tauri/artifacts/benchmarks/comparison-*/report.json
```

The comparison uses median values. WebView2 and Chromium create different process topologies, so process count alone is not treated as a performance score.

## Matched Electron / Tauri result

Formal matched report:

```text
report:       comparison-2026-08-11T19-29-37-877Z/report.json
stabilize:    10 seconds
samples:      5 per product/scenario
workspace:    C:\Projects\sovereign-code-runtime
Windows:      current development machine
```

### R0 — shell

| Metric                     |      Electron |         Tauri |                                  Change |
| -------------------------- | ------------: | ------------: | --------------------------------------: |
| Product private median     | 316,547,072 B | 263,028,736 B | **-16.91% / -53,518,336 B (~51.0 MiB)** |
| Shell private median       | 238,788,608 B | 189,788,160 B | **-20.52% / -49,000,448 B (~46.7 MiB)** |
| Product working-set median | 445,865,984 B | 447,303,680 B |                                  +0.32% |
| Startup ready              |       1706 ms |        622 ms |                             **-63.54%** |
| Median process count       |             5 |             9 |     WebView2 uses more helper processes |

### R1 — runtime running

| Metric                     |      Electron |         Tauri |                                  Change |
| -------------------------- | ------------: | ------------: | --------------------------------------: |
| Product private median     | 303,169,536 B | 263,536,640 B | **-13.07% / -39,632,896 B (~37.8 MiB)** |
| Shell private median       | 222,343,168 B | 187,445,248 B | **-15.70% / -34,897,920 B (~33.3 MiB)** |
| Product working-set median | 457,850,880 B | 446,107,648 B |  **-2.56% / -11,743,232 B (~11.2 MiB)** |
| Startup ready              |       1439 ms |        691 ms |                             **-51.98%** |
| Median process count       |             5 |             9 |     WebView2 uses more helper processes |

## Interpretation

The refactored Tauri shell provides a real performance improvement under the current self-use workload:

- private memory is lower in both matched scenarios;
- the normal runtime-running scenario saves about **37.8 MiB product private memory** and **33.3 MiB shell private memory**;
- runtime-running working set is also lower by about **11.2 MiB**;
- startup-to-ready time is roughly halved;
- the Runtime Host, Gateway, 48-tool manifest, workspace policy, approval policy, audit/run layers, and Windows Adapter remain shared rather than being duplicated in Rust.

R0 working set is essentially flat/slightly higher (+0.32%), so the migration should not be described as universally lower in every memory metric. WebView2 also uses more helper processes than the legacy Electron baseline. The meaningful wins are private memory and startup latency, with a modest R1 working-set reduction.

## Original stretch budget status

The earlier POC document set a deliberately aggressive continuation target of either >=20% lower product idle private memory or >=75 MiB absolute reduction, plus >=30% lower shell private memory. The measured Tauri shell **does not meet those stretch memory thresholds**: R0 product private is -16.91% and shell private is -20.52%.

For the current self-use objective, the refactor is nevertheless accepted as the primary shell because it delivers measurable 13–17% product-private savings, >50% startup improvement, a self-contained portable Node sidecar, and the same control-plane/security boundaries. The legacy Electron shell remains available through explicit `legacy-electron` commands as a rollback path.

Do not silently rewrite the original stretch target after measurement. If the product later needs a production migration gate, either meet that target through further optimization or approve a new budget explicitly with new workload evidence.

## Leak / lifecycle budgets

The next performance work should focus on lifecycle stability rather than another shell rewrite:

```text
30 minute idle private growth           <= 10%
50 view switches + 2 minute settle      <= baseline + 15 MiB
Terminal close + 30 second settle       <= pre-open + 10 MiB
Browser close + 60 second settle        <= pre-open + 30 MiB
100 approval cycles                     no orphan windows/renderers and <= pre-run + 15 MiB
```

The budget evaluator is now available as a separate fail-closed gate:

```text
pnpm performance:lifecycle:check -- <lifecycle-report.json>
```

The input uses `scr.lifecycle-benchmark/v1` and records the before/after product-private byte counts for the five scenarios above, plus orphan window/renderer counts for approval cycling. The evaluator does not manufacture measurements or relax limits: malformed evidence, unsafe numeric values, any over-budget delta, or any approval orphan fails the command. Workload automation that produces these measurements remains separate so measurement collection cannot silently redefine the acceptance budget.

Any future optimization must preserve workspace containment, L1/L2/L3/L4 semantics, approval fail-closed behavior, DPAPI-protected secret storage, audit receipts, run recovery, and the Runtime Host protocol boundary.
