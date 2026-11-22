# AI connections

The desktop connection page supports ChatGPT and Gemini while keeping host and workspace permissions in one place. These desktop controls are available from version 0.1.7; version 0.1.6 supports the Gemini bridge through the [source command](gemini-connection.md#run-from-a-source-checkout).

## Choose a client

Open **AI Connections** and select **ChatGPT** or **Gemini**. The summary above the client tabs shows the shared host, workspace permissions and total active MCP sessions. That session count is not a client identity check.

Use **Manage permissions** to review the current workspace's shared AI access. Changing that profile affects the Gateway used by all clients. The page does not imply separate permission profiles for each tab.

The connection configuration can be collapsed after setup. Existing ChatGPT tunnel, connector, proxy and fallback controls remain available.

## ChatGPT

Configure the tunnel identifier and runtime key supplied for your connection, then start the tunnel. The connector selection and integrity check, saved-key controls, connection check, proxy routes and direct fallback retain their existing behavior.

A ready tunnel means the route is available. It does not establish that a particular ChatGPT conversation has created an MCP session.

## Gemini

Gemini uses the existing OAuth MCP bridge. It does not use a Gemini model API key.

1. Provide your public HTTPS MCP address, OAuth discovery and introspection URLs, OAuth client ID and the local port reached by your HTTPS proxy.
2. Enter the authorized owner subject and the introspection service's Authorization value. Save the configuration.
3. Start the listener. Add the public MCP address to the client using your OAuth service.

The application uses the current local Gateway connection internally. You do not need to copy a Gateway bearer into this form. The desktop configuration is separate from the optional command-line bridge pairing.

You must already have a suitable HTTPS route and OAuth authorization server. Saving a URL does not create either service or prove that the public route is reachable. See [Gemini connection requirements](gemini-connection.md#requirements) for the required token scope, client, owner, audience and PKCE behavior.

The page distinguishes unconfigured, saved, starting, listening and error states. **Listening** describes the application's local bridge; it does not claim that Gemini has authenticated or completed a client connection.

### Saved credentials

Owner identity and introspection credentials use the desktop's protected secret storage. Saved values are not sent back to the page. Leave an existing value unchanged, replace it explicitly, or use its forget control. Forgetting a required value leaves the connection unconfigured until it is supplied again.

The page keeps unsaved edits only in its current renderer memory. Secrets are not placed in interface preferences or browser local storage.

### Stop, restart and port conflicts

Saving a changed configuration rebuilds this Gemini listener when it is already enabled. Saving while it is disabled does not start it.

Stopping the Gemini listener changes only the listener owned by this runtime. It does not stop the Gateway or the ChatGPT tunnel. A port already owned by another bridge is reported as a conflict; the application does not terminate that process.

The normal packaged runtime preserves Gemini's separate start/stop intent across host restarts and owner changes. Candidate and isolated verification runtimes do not automatically restore a listener against an existing user's OAuth service.

## Local and other MCP clients

Expand **Local and other MCP clients** for the existing local endpoint, fallback route and connection-bundle controls. The trusted desktop process performs any credential-bearing clipboard operation; the connection page does not retain that bundle as display state.

## Troubleshooting

If saving fails, correct the reported field or protected-storage problem before starting. If startup fails, check that the Gateway is running, the local port is free, and the configured OAuth discovery service supports the required flow. Public HTTPS routing is managed by your deployment.

A failed or interrupted tool write is not automatically replayed after reconnecting. Inspect its existing result or durable job identifier before requesting another write.
