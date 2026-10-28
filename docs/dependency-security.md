# Dependency security review

Review date: 2026-10-28. The lockfiles, not this prose, identify the resolved graph. Advisory data changes; rerun both production and complete audits on the exact candidate before release.

## Targeted JavaScript changes

The root pnpm overrides constrain known affected ranges for fast-uri to 3.1.9, proxy-addr to 2.0.8, ip-address to 10.7.4, source-map-js to 1.2.2, brace-expansion to the separate compatible 1.1.21 and 2.1.7 branches, qs to 6.16.1, body-parser to 2.4.0, undici to 7.30.1 and 6.29.1 on their existing major branches, http-cache-semantics to 4.3.0, Hono to 4.13.11, and @xmldom/xmldom to 0.9.12. Vitest is pinned to 4.1.12, including its matching mocker implementation. Zod is updated to the 4.x line (^4.6.7) in the Gateway, toolkit and control-plane packages because the memory-exhaustion advisory has no 3.x fix; the MCP SDK declares support for both Zod 3.25 and Zod 4. These are configuration requirements; verify their actual resolution and audit results after a frozen install.

The Gateway SDK is pinned to 1.32.1, retaining the 1.30.1 HTTP body and batch limits, the 1.31.0 OAuth issuer-binding change, and the 1.32.0 same-origin redirect, session-bound task store and bearer audience fixes. This repository uses the SDK server and a stdio sidecar client; its production code does not configure an SDK HTTP OAuth provider. Applications adding such a provider must follow the [upstream credential-migration and expectedIssuer instructions](https://github.com/advisories/GHSA-6qxp-vccf-f47h). Updating the package alone does not migrate credentials stored by an external application. Electron is updated to 43.8.1 for GHSA-jr5w-w6x2-84p9 and the earlier 43.x advisories.

The 2026-10-28 dependency graph passes both the production and the complete npm audit with zero advisories. The earlier braces (GHSA-vfj7-8cjw-p6xm) and sprintf-js (GHSA-hp3w-g68c-fv3c) findings were withdrawn upstream. The http-cache-semantics advisory (GHSA-ch52-4w7c-c8xp) lists no patched version but affects only 4.2.0 and earlier; the override selects 4.3.0, which is within cacheable-request's declared range. Its release notes do not explicitly describe a max-stale fix, so treat this as leaving the advisory range rather than a confirmed remediation, and recheck upstream. No advisory is suppressed and the complete audit remains enforced in CI.

Electron Forge 7.11.2 still requests @electron/rebuild 3.x. Its core, core-utils, and shared-types edges are deliberately overridden to @electron/rebuild 4.0.6, which uses node-gyp 12 rather than the older Git-sourced node-gyp chain. This is a scoped, cross-major compatibility exception, not an upstream Forge compatibility guarantee. It requires Node 22.12 or later; this project requires Node 24. Test the real Forge IPC rebuild worker on the declared Node version and perform full native Electron packaging acceptance before claiming that legacy packaging is release-ready.

The tar override applies only to already-7.x edges, selecting 7.5.21 or the patched lock resolution. It does not force tar 7 into a tar 6 consumer. The external-editor-to-tmp edge is pinned to 0.2.7 (including the follow-up GHSA-7c78-jf6q-g5cm fix); validate temporary-file creation and cleanup at that integration point. Revisit these overrides when the parent packages incorporate the fixes.

Upstream references:

- fast-uri: https://github.com/advisories/GHSA-5jgf-p345-68v8
- fast-uri host normalization: https://github.com/advisories/GHSA-hrr3-gc8f-f4qj
- proxy-addr trust-subnet handling: https://github.com/advisories/GHSA-jqcg-44mw-7w3h
- ip-address family comparisons and parse diagnostics: https://github.com/advisories/GHSA-j6r3-76f7-8jcv and https://github.com/advisories/GHSA-h3mg-xc3c-68pw
- brace-expansion: https://github.com/advisories/GHSA-q2hr-2g5m-vwhr
- source-map-js: https://github.com/advisories/GHSA-68fv-2mgg-jv7q
- qs: https://github.com/advisories/GHSA-x5fp-wj9c-mxmx
- Hono security releases: https://github.com/honojs/hono/releases
- node-tar: https://github.com/advisories/GHSA-r292-9mhp-454m
- Vitest: https://github.com/advisories/GHSA-82fw-gwwq-j7x9, https://github.com/advisories/GHSA-qxg6-89mg-rqv8 and https://github.com/advisories/GHSA-xp26-3454-mjgp
- MCP SDK 1.32.0: https://github.com/advisories/GHSA-46jr-4wx8-v453, https://github.com/advisories/GHSA-22jm-h49p-29qw, https://github.com/advisories/GHSA-rvq5-wwqv-78pq and https://github.com/advisories/GHSA-6prh-2h8m-c8cw
- Zod: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- body-parser: https://github.com/advisories/GHSA-27r3-jxmh-p828
- http-cache-semantics: https://github.com/advisories/GHSA-ch52-4w7c-c8xp
- Electron: https://github.com/advisories/GHSA-jr5w-w6x2-84p9
- Forge dependency tracking: https://github.com/electron/forge/issues/4228

## Electron archive extraction replacement

The sole legacy extract-zip edge is scoped to Electron Packager: `@electron/packager>extract-zip` resolves to `npm:@electron-internal/extract-zip@1.0.5`. This is Electron's own native extraction implementation, not a renamed copy or an audit suppression. Other consumers are not globally redirected. The published integrity and source commit are recorded in the dependency inventory. The legacy 2.0.1 package and its exclusive dependencies are removed from the lock graph.

Packager 18.4.4's CommonJS unzip boundary supplies only the supported absolute `dir` option. Node 24 can load this package's default ESM export through that boundary. The regression suite calls the actual Packager API, checks stored/deflated output, path containment, escaping symlink targets, both duplicate-entry orders, malformed data, and unchanged synthetic data outside the extraction directory. Absolute prefixes are stripped according to the upstream contract; error-only assertions would misdescribe that behavior.

This precise alias is a compatibility exception until the parent incorporates a supported replacement. Recheck it after Node, Packager, or extractor changes. The previous GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3 findings concerned the removed package. A current zero-finding audit is evidence about the scanned graph and advisory database, not a security guarantee.

The replacement is supported by upstream only for checksum-validated, trusted Electron distribution archives through Electron tooling and a fresh, trusted extraction destination. Do not use arbitrary ZIP inputs, unauthenticated mirror content, or attacker-populated destinations. Our bounded negative tests do not broaden that threat model or establish complete native packaging acceptance on every platform. The published 1.0.5 metadata declares BSD-2-Clause, but its exact-version license text was not found; the existing inventory gap remains explicit for binary-distribution review.

Primary sources:
- https://github.com/electron/extract-zip
- https://github.com/electron/extract-zip/blob/b83e459fd04c53b0a1c8438a6792df8f64be47fc/SECURITY.md
- https://github.com/advisories/GHSA-jmr9-qjv8-65gv
- https://github.com/advisories/GHSA-7pqw-9j4j-h8q3

## Target-specific findings and limits

Cargo and Android findings require their own exact-version and target analysis. A non-Windows Cargo resolution is not proof of Windows executable inclusion; conversely, absence from the Windows target does not resolve risk on other targets. Keep maintenance/unmaintained notices distinct from exploitable-vulnerability claims. The [third-party inventory](../THIRD_PARTY_NOTICES.md) is not a security audit or a binary bill of materials.

## Recheck

From the source root after a frozen install:

```powershell
pnpm audit --prod
pnpm audit
```

Archive the command exit statuses and JSON output privately with the source commit and lockfile hashes. Refresh license metadata and preserve exact upstream notices whenever the graph changes. Do not place private audit logs or developer handoffs in the public source snapshot.
