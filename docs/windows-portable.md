# Windows Portable

This package runs Sovereign Code Runtime on Windows 10/11 x64. It contains the desktop shell, Node.js Runtime Host, native Windows helper, component manifest, and public license notices.

## Download and verify

Check [GitHub Releases — latest](https://github.com/DZ20000/sovereign-code-runtime-public/releases/latest) for Windows x64 Portable availability. Once a release lists both files below, download them from that release's **Assets** section:

- SovereignCodeRuntime-VERSION-windows-x64.zip
- SovereignCodeRuntime-VERSION-windows-x64.zip.sha256

If no release or matching assets are listed yet, use the [source build instructions](../README.md#desktop-application) until publication.

The automatically generated GitHub "Source code" archives are source snapshots, not the runnable application.

In PowerShell, replace VERSION with the release version and verify the downloaded ZIP:

~~~powershell
$zip = "SovereignCodeRuntime-VERSION-windows-x64.zip"
$expected = ((Get-Content "$zip.sha256" -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected.ToLowerInvariant()) { throw "Checksum mismatch; do not launch this download." }
Expand-Archive -LiteralPath $zip -DestinationPath ".\SovereignCodeRuntime-VERSION"
~~~

A matching checksum checks the downloaded bytes against the accompanying release file. It is not a Windows publisher signature.

## Start

1. Install the Microsoft Edge WebView2 Runtime if it is not already available: https://developer.microsoft.com/microsoft-edge/webview2/
2. Extract the entire ZIP to a writable directory and run SovereignCodeRuntime.exe from that directory.
3. Keep the node and native subdirectories beside the executable. Moving only the executable breaks its embedded runtime.
4. Configure your own workspace and optional connections in the application. The download contains no preconfigured user workspace, credentials, browser profile, tunnel configuration, or local Tasks database.

Node.js is bundled. End users do not need Node, pnpm, Rust, or a compiler to start this package. The native helper uses the Windows .NET Framework runtime. The optional official tunnel client, Python tools, Docker, and semantic-analysis sidecars are separate installations and are not included.

Application data lives in the application's per-user data directory. "Portable" describes the extracted application files; it does not mean that settings and databases are stored beside the executable. Keep the extracted directory in place if you register that copy for login startup.

## Update and remove

Extract a newer release into a new directory. Close the old application before starting the new executable. Confirm the expected version and source commit before retiring the old directory; preserve user data and recovery evidence.

Removing the extracted application directory does not remove its per-user settings or databases. Remove any startup entry that points to that directory before deleting it.

## What the manifest records

The included portable-package.json records the public source commit, product version, clean-source state, and every runtime component's SHA-256 and byte length. Public releases include an empty renderer trust registry; a local developer's update authority is not distributed with the application.

LICENSE and NOTICE describe the original project. THIRD_PARTY_NOTICES.md and licenses retain the repository's public dependency evidence, together with the exact bundled Node distribution's license. The source dependency inventory includes development dependencies as well as runtime dependencies; it is not presented as a binary-only bill of materials.

## Maintainer build

Use a clean Git checkout of the public release commit on Windows x64. Source archives without Git metadata are not supported. Required build tools are Node.js 24, pnpm 10.15.1, Rust with the MSVC target, Visual C++ Build Tools/Windows SDK, the Windows .NET Framework C# compiler, and WebView2 for the isolated desktop smoke tests.

~~~powershell
pnpm install --frozen-lockfile
pnpm --filter @sovereign/desktop-tauri run test:portable-release
pnpm --filter @sovereign/desktop-tauri run release:portable
~~~

The release wrapper rebuilds the application from source, maps checkout/Cargo/profile paths out of Rust output, runs the isolated Portable and Guardian smoke tests, then creates a ZIP and SHA-256 file under apps/desktop-tauri/artifacts/release. These smoke tests launch and stop their own candidate processes. They do not install or activate a user's existing application.

The ZIP writer uses an explicit file allowlist, verifies every archived file by reading it back, and checks public metadata and content before publishing the archive. It never recursively archives the local artifacts directory. Local reports and latest-portable pointers remain outside the ZIP. Existing release filenames are not overwritten.

The GitHub Windows Portable release workflow runs only for a version tag whose commit is already on origin/main and whose version matches the committed package metadata. It requires the existing source-check workflow's source, full dependency audit, and Android jobs to pass for the exact commit. It rebuilds on a fresh Windows runner and publishes the ZIP plus checksum without replacing existing release assets.

After the reviewed change has merged and source checks have passed, maintainers create and push the matching tag. For example, version 0.1.6 uses tag v0.1.6. To retry a failed release workflow after repairing a transient runner problem, dispatch it on the existing tag. A failed source or privacy check must be resolved in a new reviewed commit and version; do not bypass the check or move an already published tag.
