# Privacy and local data

Sovereign Code Runtime is designed around local execution. The source preview does not contain a project-operated telemetry or analytics service.

## Data handled locally

Depending on enabled features, Sovereign may process or persist:

- authorized workspace paths and permission settings;
- task state, bounded audit evidence, and local run metadata;
- local process, terminal, browser, and desktop observations requested through tools;
- connection settings and tunnel credentials;
- update metadata and integrity records.

Some of this data can be sensitive even when it is not a credential.

## Credentials

Gateway Bearer credentials and tunnel/runtime keys must not be committed to source control or included in public bug reports. Persisted Windows tunnel credentials and proxy settings are protected with Windows DPAPI for the current user context. DPAPI protects stored material from casual disclosure; it is not a substitute for operating-system account security.

## Network boundaries

The MCP Gateway is intended to bind to loopback. A configured tunnel or connector can communicate with its external service as part of the feature the operator explicitly enables. Optional control-plane proxies coordinate route selection and do not proxy local MCP payloads.

## Diagnostics and reports

Before sharing logs, screenshots, databases, issue reproductions, or audit evidence, remove credentials, personal paths, workspace contents, cookies, tokens, and other private data. Public issue templates intentionally ask reporters to confirm redaction.

## Third-party services

When Sovereign is connected to an external MCP client, tunnel provider, browser target, or other service, data sent to that service is governed by that service's own terms and privacy practices. This project does not make those third-party services part of Sovereign's privacy boundary.
