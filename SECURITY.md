# Security policy

## Source-preview status

This is a source preview, not a security-certified or deployment-approved release. There is no promised support window, security SLA, trusted binary feed, or enabled automatic update service. Review the [threat model](docs/threat-model.md) and [dependency review](docs/dependency-security.md) before using it on a machine containing sensitive data.

## Supported versions

Sovereign Code Runtime is currently published as a source preview. There is no announced binary release, long-term support branch, or security SLA.

Security fixes are evaluated against the current public `main` branch unless a repository advisory explicitly states otherwise.

## Reporting a vulnerability

Please do not report suspected security vulnerabilities through public Issues, Discussions, pull requests, or public reproduction repositories.

Use [GitHub Private Vulnerability Reporting](https://github.com/DZ20000/sovereign-code-runtime-public/security/advisories/new).

Include, when applicable:

- the exact affected commit SHA;
- the affected component and operating system;
- Node.js, pnpm, and relevant dependency versions;
- the Sovereign permission profile required to reproduce the issue;
- expected versus observed behavior;
- a minimal reproduction using disposable or synthetic data; and
- an assessment of security impact.

Do not include live Bearer tokens, tunnel runtime keys, cookies, signing keys, DPAPI-protected material, personal workspace paths, database contents, or other credentials.

Please coordinate disclosure through the private report before publishing exploit details or a working reproduction. This source preview does not promise a response or remediation SLA.

## Operational boundaries

The Gateway is loopback-only and requires a separately generated Bearer credential. Example and empty values are rejected, but configuration validation cannot prove a token has adequate entropy. Generate at least 32 random bytes as shown in [development](docs/development.md). Never use documentation or test fixture tokens for a live instance.

Terminal, Python, browser evaluation, and desktop control are not operating-system sandboxes. Workspaces, permission profiles, approval, and audit reduce specific risks; they do not make an untrusted program harmless. Use a dedicated machine or appropriate isolation for untrusted code. Human credential entry and Secure Desktop interaction remain human responsibilities.

Dependency audit results are advisory-database snapshots. A clean production-only npm audit does not cover development tools, native crates, Android dependencies, operating-system components, or separately installed clients. Package build, signature verification, installation, activation, and observed running behavior require separate evidence. Source CI never authorizes installation, restart, elevation, or publishing.
