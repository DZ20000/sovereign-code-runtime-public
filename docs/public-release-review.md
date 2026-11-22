# Public source and release boundary review

Version: 0.1.6. Review date: 2026-11-22.

## Source boundary

This synchronization starts from the existing public main revision c7191bb. Changes are selected public patches; the synchronization does not merge an unrelated repository history. The retained public file-handle, hard-link, native destructive-operation, child-environment and shutdown protections remain in place.

The release adds bounded PNG/JPEG/WebP reading and native MCP image content, an optional authenticated Gemini connection, conversation correlation across transports, shared paging and write-audit logic, and schemas derived from the validated Zod inputs. It removes 34 unused update prototypes while preserving the four update modules actually consumed by desktop packaging and verification.

Protected Gemini pairing uses explicit Windows built-in modules, bounded child processes and fixed diagnostics that omit credentials. The normal packaged runtime refreshes only an existing pairing; passive candidates, development builds and isolated test/preflight/custom-data runs cannot publish it. Promotion and rollback follow the existing owner transition, and a cancelled update cannot continue as a detached background write.

Workspace instructions and skills are exposed through bounded read-only discovery using existing workspace capabilities, path guards and connection reach. Text and image reads share the same bounded opened-handle reader. The Git push hook clears inherited repository-local environment variables before validation so temporary test repositories cannot alter the checkout being pushed.

Personal configuration, workstation bindings, local user-data directories, credentials, audit logs, private integrations, source attachments and unrelated project content are excluded. Production builds omit development workspace paths and remap Rust source paths before stripping release symbols.

## Sanitization evidence

- The source check scans tracked and pending new files, including paths and UTF-8 / UTF-16LE content.
- New-commit history is checked separately, including commit metadata and intermediate blobs. Existing public history was also checked with an independent credential scanner.
- The release ZIP is assembled from verified component entries plus an explicit set of installation and license files. Local smoke reports and generated installation pointers are not selected.
- Every ZIP entry is read back and checked against its expected length and SHA-256, then scanned again. Uninspectable, oversized, escaping or encrypted archive entries fail the check.
- Machine-specific exclusion terms are supplied only to the local validation process. The public scanner contains generic rules, not developer identities or private path lists.

The candidate source and existing public history checks returned zero findings. The exact downloadable ZIP must pass the same boundary check during release construction. Its SHA-256 sidecar and embedded component manifest identify the bytes that were checked.

## Validation and dependency updates

Complete TypeScript checking, focused file/security/audit/paging/schema/conversation tests, real MCP-to-Gemini image tests, native launcher tests, Rust library and recovery tests, and web/runtime builds were run for the candidate. The maintained source workflow also runs the full Vitest suite, the timing-sensitive integration cases serially, and Android unit tests on Linux.

The JavaScript graph was refreshed to MCP SDK 1.32.0, Zod 4.6.6, Vite 8.2.4, Vitest 4.1.12 and Electron 43.8.1 with scoped transitive fixes. Complete and production pnpm audits both returned zero findings on the review date. One existing glib advisory remains in the Linux/BSD GTK dependency graph; locked Windows x64 dependency checks exclude glib. The target-specific limitation and upstream fix are documented in dependency-security.md. Advisory data changes; the release workflow requires current checks for the exact commit.

The extended private-term review of the verified Node binary produced two ordinary upstream Unicode-label matches. Both were reviewed as false positives; the binary and scanner were left unchanged. No actual private content was found.

Node 24.22.1 is bundled. Its Windows x64 binary was matched to the official release checksum; its matching upstream license is included. The Tauri Portable does not include the legacy Electron application.

## Publication gates

The main branch requires a pull request with source, Android, dependency-audit and CodeQL checks. Release tags must match the committed product version and refer to a commit already in main. The release workflow verifies successful source checks for that exact commit, rebuilds on Windows, runs isolated portable and guardian smoke checks, scans the archive, and publishes only the ZIP and its checksum.

Check the release commit and GitHub Checks together with the archive manifest when reproducing this review. Source tests and package tests use isolated state; building or publishing a download does not install it or restart an existing runtime.

See [Windows Portable installation](windows-portable.md), [image tools](image-tools.md), [Gemini connection](gemini-connection.md), and [dependency security](dependency-security.md).
