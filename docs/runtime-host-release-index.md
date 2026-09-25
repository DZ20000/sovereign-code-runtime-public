# Runtime Host release-index managed import

The desktop Tauri package can verify a signed local Runtime Host release index and stage verified Runtime candidate packages into the managed inbox without adding a network downloader or a new trust root.

```powershell
pnpm --filter @sovereign/desktop-tauri runtime:index:stage -- `
  --source-root <local-release-feed-root> `
  --index release-index.json `
  --index-trust <shell-owned-release-index-trust.json> `
  --runtime-trust <shell-owned-runtime-candidate-trust.json> `
  --managed-root <runtime-update-root> `
  --shell-version <signed-shell-version> `
  --runtime-protocol-version 1
```

## Trust boundary

The release-index signing registry and Runtime candidate signing registry are separate shell-owned files. Neither may be supplied from inside the untrusted release source tree. Both are canonical JSON, use Ed25519 public keys, and can constrain the sequence range accepted for each key.

The release index is a signed canonical envelope with a monotonically increasing `indexSequence`, an expiry time, and a strictly sorted release list. Each entry binds:

```text
releaseId
releaseSequence
portable packagePath
envelopeSha256
runtimeHostSha256
```

Every referenced Runtime package is independently verified against its existing Runtime candidate signature, shell-version requirement, Runtime protocol version, exact envelope digest, exact Runtime Host digest, and release identity before publication.

## Managed import

The importer creates only two managed child directories:

```text
inbox/
import-receipts/
```

A package that is not already present is copied into a uniquely owned `.import-<nonce>.tmp` directory, verified again after the copy, then renamed into its immutable `inbox/<releaseId>` location. Existing packages are reverified instead of overwritten.

Receipts are canonical, immutable files whose names contain the index sequence and content digest. Every receipt binds the previous raw receipt SHA-256. The chain therefore detects receipt deletion, mutation, conflicting sequence reuse, release-identity drift, and replay.

The importer refuses:

- an index sequence lower than the latest receipt;
- the same sequence with a different signed index;
- a newer index that contains no advancing content;
- a newly adopted or staged release whose sequence does not exceed all previously recorded releases;
- an idempotent receipt whose managed package disappeared or no longer verifies.

## Filesystem boundary

Source and managed roots must be separate direct directory trees and cannot be filesystem roots or direct children of a volume root. Portable relative package paths reject `..`, absolute paths, backslashes and unsupported segments. Trust registries, source packages, managed inbox entries and receipt files reject symbolic links, junction traversal and hard-linked files. Security-sensitive files are opened directly, compared with their pre-open identity, read through the opened handle, then checked again for identity, size and timestamp changes before their contents are accepted.

Cleanup is intentionally narrow. Only importer-owned `.import-<nonce>.tmp` directories can be removed, and only after their direct inventory is proven to contain the two expected files. There is no recursive arbitrary-path deletion primitive.

## Managed consistency audit

After import, the managed inbox can be checked again without changing Runtime authority:

```powershell
pnpm --filter @sovereign/desktop-tauri runtime:index:audit -- `
  --managed-root <runtime-update-root> `
  --runtime-trust <shell-owned-runtime-candidate-trust.json> `
  --shell-version <signed-shell-version> `
  --runtime-protocol-version 1
```

The audit is read-only. It validates the complete receipt hash chain, requires every receipted release to still exist in the inbox, rejects unreceipted inbox directories, reverifies every Runtime candidate signature and exact package hashes, and confirms the signing key recorded in the receipt still matches the package. It refuses to run while an import lock exists so it never reports a transient in-progress import as consistent.

## Scope

These commands perform **local verification, staging and read-only consistency checks only**. They do not download, install, activate, cut over, restart, or change the current Runtime Host authority. Runtime activation remains behind the existing signed Runtime Candidate owner and supervisor workflow.
