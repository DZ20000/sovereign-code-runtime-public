# Security policy

## Source-preview status

This is a source preview, not a security-certified or deployment-approved release. There is no promised support window, security SLA, trusted binary feed, or enabled automatic update service. Review the [threat model](docs/threat-model.md) and [dependency review](docs/dependency-security.md) before using it on a machine containing sensitive data.

## Reporting a vulnerability

This snapshot does not publish a security mailbox and does not assert that GitHub private vulnerability reporting is enabled. Before public release, the repository owner must configure and verify a private reporting route. Use only a contact independently verified with the maintainer. When no private route is available, post only a request for one, not exploit details, access credentials, screenshots, or personal workspace data. Do not invent an address based on a project name.

A private report should identify the exact source commit, affected component, operating system and dependency versions, required permission level, expected versus actual behavior, and a minimal reproduction using disposable data. Redact Bearer tokens, tunnel runtime keys, DPAPI material, signing keys, cookies, personal paths, and database contents. Coordinate disclosure before publishing sensitive reproduction details.

## Operational boundaries

The Gateway is loopback-only and requires a separately generated Bearer credential. Example and empty values are rejected, but configuration validation cannot prove a token has adequate entropy. Generate at least 32 random bytes as shown in [development](docs/development.md). Never use documentation or test fixture tokens for a live instance.

Terminal, Python, browser evaluation, and desktop control are not operating-system sandboxes. Workspaces, permission profiles, approval, and audit reduce specific risks; they do not make an untrusted program harmless. Use a dedicated machine or appropriate isolation for untrusted code. Human credential entry and Secure Desktop interaction remain human responsibilities.

Dependency audit results are advisory-database snapshots. A clean production-only npm audit does not cover development tools, native crates, Android dependencies, operating-system components, or separately installed clients. Package build, signature verification, installation, activation, and observed running behavior require separate evidence. Source CI never authorizes installation, restart, elevation, or publishing.
