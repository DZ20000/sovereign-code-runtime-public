# Windows Portable 0.1.6 verification

The first refreshed public Portable release is published at [v0.1.6](https://github.com/DZ20000/sovereign-code-runtime-public/releases/tag/v0.1.6).

| Item | Verified result |
| --- | --- |
| Public source commit | `634c3759380dc3c22339da4e06a7b36c87c0a91c` |
| Archive | `SovereignCodeRuntime-0.1.6-windows-x64.zip` |
| Archive size | 41,572,250 bytes |
| SHA-256 | `a094257bd70683cd09d5099fa6a40013362365cb7133094a3914543c53cc561c` |
| ZIP entries | 533 |
| Runtime components verified against the embedded manifest | 8 |
| Installation and license files matched to the public Git commit | 523 |
| Duplicate, extra, missing or CRC-invalid entries | 0 |
| Embedded source state | Clean; no pending changes |
| Renderer update trust registry | Empty |
| Unauthenticated direct asset request | HTTP 200 |

The downloaded ZIP matched both its published checksum sidecar and GitHub's asset digest. Its bundled Node 24.22.1 Windows x64 binary matched the official distribution hash `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`.

## Build and test evidence

[Portable release workflow](https://github.com/DZ20000/sovereign-code-runtime-public/actions/runs/45053466873) completed successfully. It checked the main-line tag and exact-commit source results, rebuilt on a clean Windows runner, passed isolated Portable and guardian recovery smokes, confirmed unchanged source and published the ZIP plus checksum.

The merged commit's [Windows source checks](https://github.com/DZ20000/sovereign-code-runtime-public/actions/runs/45052570434) and [CodeQL analysis](https://github.com/DZ20000/sovereign-code-runtime-public/actions/runs/45052570484) passed. The reviewed candidate also passed 1,398 Vitest cases across 199 files, 70 Rust library cases, recovery checks, Android tests and the complete and production JavaScript dependency audits.

## Privacy review

The downloaded archive was independently read and checked, not inferred from a locally built candidate. The extended review covered 1,311 source files, the merged commit and its 74 changed history blobs, and every archive entry. Thirteen private-binding terms and four path rules were supplied only to the local scanning process.

That intentionally broad scan returned four raw matches. Two were the scanner's own generic machine-name-prefix detection expression, once in source and once in the commit blob. Two were ordinary Unicode labels in the unchanged official Node binary. All four were reviewed as false positives; no scanner suppression or binary modification was introduced. No actual private content was found.

This is evidence for these exact downloaded bytes. It does not imply that later artifacts, different dependency targets or future advisory databases have the same result. The existing Linux/BSD-only GTK dependency limitation is recorded in [dependency security](dependency-security.md); the Windows x64 locked dependency graph excludes that package.

Publication and verification did not install the package, alter an existing user profile or restart an active runtime.
