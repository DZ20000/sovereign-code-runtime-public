# Optional Gemini MCP connection

The Gemini bridge projects the active Sovereign MCP catalog for clients that require underscore tool names. For example, `files.read_image` becomes `files_read_image`. Input schemas, descriptions and annotations come from the active gateway. Image content remains native MCP image content.

This is a general gateway connection. It does not install private conversation providers or a separate AI Web service.

## Requirements

- A running Sovereign gateway and its authorized local connection bundle.
- Windows for protecting the local bundle with the current account's DPAPI.
- An OAuth authorization server with authorization-code flow, PKCE S256, discovery and token introspection.
- A public HTTPS endpoint ending in `/mcp`, routed to the bridge's loopback listener.
- OAuth access tokens with scope `sovereign.mcp`, the configured client and owner subject, and the exact public MCP URL as audience.

The bridge validates these token properties on each request. The local connection still determines workspace access, capabilities and approval policy. The bridge does not grant additional local permissions.

## Run from a source checkout

Build the gateway first:

```powershell
pnpm --filter @sovereign/gateway build
```

Supply the following settings through your process or secret manager:

| Setting | Meaning |
| --- | --- |
| `SCR_GEMINI_MCP_URL` | Public HTTPS `/mcp` URL. |
| `SCR_GEMINI_OAUTH_DISCOVERY_URL` | HTTPS authorization-server discovery URL. |
| `SCR_GEMINI_OAUTH_INTROSPECTION_URL` | HTTPS introspection URL, or an explicit `http://127.0.0.1` service on the same machine. |
| `SCR_GEMINI_OAUTH_INTROSPECTION_AUTHORIZATION` | Authorization header for the introspection service. |
| `SCR_GEMINI_OAUTH_CLIENT_ID` | Exact OAuth client identifier. |
| `SCR_GEMINI_OAUTH_OWNER_SUB` | Exact owner subject allowed to use this connection. |
| `SCR_GEMINI_LOOPBACK_PORT` | Local port for your HTTPS proxy; `0` selects an ephemeral port. |
| `SCR_GEMINI_LOCAL_CONNECTION_BUNDLE` | Local Sovereign connection JSON, required for first pairing or an explicit replacement. |

Start the bridge:

```powershell
node scripts/gemini-gateway-server.mjs
```

The first explicit bundle is encrypted into the current Windows user's application-data directory. Later starts can omit the bundle setting. Do not commit bundles, tokens, introspection credentials or private deployment settings to a repository.

The process listens only on `127.0.0.1`. Configure your own HTTPS proxy and OAuth server; this repository does not prescribe a domain, tunnel account or identity-provider realm.

## Updates and request identity

A runtime owner can publish an updated endpoint and bearer credential through the exported `refreshRegisteredGeminiConnection` function. This function changes only an existing pairing. The bridge reloads a registered connection when its local gateway becomes unavailable or rejects the old credential.

The bridge binds external session references to the authenticated OAuth client. It removes downstream host-correlation metadata before forwarding tool calls. A local connection change can initialize a new upstream transport while retaining the external session reference.

A failed or interrupted tool call is not retried automatically. If a write may have been submitted, inspect its existing result or durable job identity before deciding what to do next.

## Validation

Focused tests cover OAuth identity and audience checks, encrypted local pairing, catalog fidelity, image delivery, session isolation, local connection changes and non-replay of uncertain writes. No live OAuth account or model call is required for these tests.
