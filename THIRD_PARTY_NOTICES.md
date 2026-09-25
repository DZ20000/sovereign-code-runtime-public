# Third-party components and distribution notices

The Apache-2.0 license in [LICENSE](LICENSE) applies to original Sovereign Code Runtime material. It does not replace the licenses or copyrights of third-party software, data, tools, or platform runtimes. Preserve upstream notices when redistributing their material. [NOTICE](NOTICE) identifies the original project; the evidence below identifies dependencies separately.

## Source dependency inventory

[licenses/dependency-inventory.json](licenses/dependency-inventory.json) records package names, exact versions, declared licenses, public source locations, and available license-text evidence. It includes 531 npm package-version records from the workspace dependency metadata, 524 external Cargo records from the resolved metadata, and 162 Android `debugRuntimeClasspath` components. Maven entries without a license in their own POM are resolved through their published parent POMs where indicated.

The npm coverage is the graph reported by pnpm on the validation platform; optional lockfile resolutions omitted by that report are listed explicitly in the inventory and still need review for other target distributions. This is a source-development inventory, not a binary-release bill of materials. It includes development tools and Cargo packages for platforms other than Windows. Android build plugins, the JDK, the Android SDK, operating-system components, and separately installed optional tools are outside that runtime-classpath inventory.

[licenses/third-party/](licenses/third-party/) preserves 517 distinct upstream license and notice texts, deduplicated by SHA-256 without rewriting copyright holders or attribution. Each inventory record links its available texts. Some exact package distributions declare a license but do not ship a top-level license text, or their text was unavailable in the local installation. The 60 npm/Cargo records marked `declared-license-only` must be checked against their exact source archive if included in a binary redistribution; they have not silently been assigned a generic project copyright. This inventory is not a claim that every installer notice or source-delivery obligation has been completed.

## Components requiring particular care

### Mozilla Public License 2.0

The resolved metadata includes `lightningcss` and its Windows platform package in the JavaScript build toolchain, and `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, and `selectors` in the Cargo graph. Their exact versions and source archive locations are in the inventory.

When distributing MPL-covered executable material, make the corresponding covered source available under the MPL and tell recipients how to obtain it. Modifications to covered files retain the relevant source-license obligations. The presence of a file-scoped MPL dependency does not by itself relicense every independent Sovereign source file. Build-time use and inclusion in the shipped executable are different questions; inspect the actual release composition rather than treating this entire development inventory as shipped code.

Authoritative reference: https://www.mozilla.org/en-US/MPL/2.0/FAQ/

### Creative Commons data and attribution

`caniuse-lite` 1.0.30001809 declares CC-BY-4.0 and contains browser-support data associated with the Can I Use project. `spdx-exceptions` 2.5.0 declares CC-BY-3.0 and contains SPDX license-exception data. `spdx-license-ids` 3.0.23 declares CC0-1.0. Preserve the applicable attribution, license references, and change indications when distributing their covered data. This repository's license-evidence copies do not modify those upstream texts or claim ownership of the underlying data.

Projects and license references:

- https://github.com/browserslist/caniuse-lite
- https://github.com/jslicense/spdx-exceptions.js
- https://github.com/jslicense/spdx-license-ids
- https://creativecommons.org/licenses/by/4.0/
- https://creativecommons.org/licenses/by/3.0/
- https://creativecommons.org/publicdomain/zero/1.0/

## Binary files included with the source

The Android Gradle wrapper JAR is a bootstrap tool, not the Sovereign Android application. Its SHA-256 is `81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f`, matching the published Gradle 8.13 wrapper checksum. The wrapper configuration requests the Gradle 8.14.4 distribution; wrapper-JAR version and selected distribution version are recorded separately rather than asserted to be identical. The JAR's own embedded license is preserved verbatim in [licenses/gradle-wrapper-LICENSE.txt](licenses/gradle-wrapper-LICENSE.txt).

Checksum source: https://gradle.org/release-checksums/

The small application icon is a project asset, not a screenshot of a user's desktop. Source distributions must not include personal screenshots, runtime databases, credentials, browser profiles, signing private keys, installed packages, or developer recovery records.

## Optional tools and packaged releases

Serena is an optional, separately installed semantic-analysis sidecar. The currently documented integration pins `serena-agent==1.7.0`; it is not vendored into the Runtime Host bundle. Reassess the exact tool version's license before an upgrade or redistribution. The official tunnel client and Docker-backed execution are also separate components whose distribution conditions are not replaced by Sovereign's license.

For each installer, portable package, or Android APK, identify the actual shipped dependencies and retain their notices. In particular, a bundled Node.js or Electron runtime has its own license and embedded third-party notices; operating-system WebView2 use is distinct from redistribution of a WebView2 runtime. A source inventory cannot substitute for checking those exact artifacts. Any MPL covered-source delivery, Creative Commons attribution, notice propagation, or other component-specific requirement must be satisfied for the release being distributed.
