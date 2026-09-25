# Build outputs

[简体中文](README.zh-CN.md)

This source repository does not commit installers, portable packages, APKs, or generated runtime resources. Published binaries belong in GitHub Releases with their checksums and provenance.

To locate already-built products registered by this clone and its Git worktrees:

```powershell
pnpm products
pnpm products:open
```

Or double-click `open-products.cmd`. The command only locates verified files; it does not install, launch, replace, or restart Sovereign.

| Product | Evidence shown |
| --- | --- |
| Installed Windows app | Current-user Windows registration; source identity only when its executable matches a verified installer manifest. |
| Running Windows app | Exact executable path of a live process. |
| Windows installer | Version, build date, source commit, dirty state, and manifest/file digest verification. |
| Windows portable package | Verified pointer, manifest, component digests, source commit, and dirty state. Keep the entire folder. |
| Android debug APK | Gradle output metadata. This is a development preview, not device acceptance. |

Typical local output locations are ignored by Git:

- Windows NSIS: `apps/desktop-tauri/src-tauri/target/release/bundle/nsis/`
- Windows portable: `apps/desktop-tauri/artifacts/portable-*/`
- Android debug: `apps/android-agent/app/build/outputs/apk/debug/`

A newer file, a matching version number, or a successful build does not prove that the package is installed, running, signed, or accepted. Follow [development and release validation](../docs/development.md).
