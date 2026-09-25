# Remote Host Mode

Remote Host Mode prepares one Windows computer to remain reachable from a ChatGPT Web conversation after a local Windows user signs in.

It combines restart reliability with an explicitly enabled, workspace-bound unattended binding. It restores the selected **L1 Observe**, **L2 Workspace**, **L3 Consequential**, or explicitly remembered **L4 Bypass** profile only for the exact persisted workspace root. Restoring L3 does not restore any approval: every consequential call still requires a fresh native desktop decision. L4 is restored only after its current-user Windows-DPAPI-protected exact-workspace grant decrypts and validates. Remote Host Mode does not weaken workspace containment and does not expose the Sovereign Gateway on a public interface.

## Connection path

```text
ChatGPT Web
  -> OpenAI Secure MCP Tunnel
    -> outbound HTTPS from the Windows host
      -> official tunnel-client
        -> 127.0.0.1 Sovereign Gateway
          -> permission profile / approval / policy / audit
            -> authorized Windows workspace and tools
```

The Windows host does not need a public IP address, router port forwarding, or an inbound firewall rule. It must be able to maintain the official Tunnel's outbound connection.

## What the mode configures

The **Settings → Host → Remote host** action configures a layered recovery path:

1. register the current Sovereign executable under the current user's Windows `Run` key;
2. keep the workbench alive when its window is closed by hiding it to the notification area;
3. start the loopback Gateway after the application starts;
4. bind unattended startup to the exact currently authorized workspace without replacing the remembered L1-L3 permission selection;
5. start Secure MCP Tunnel after the Gateway is ready when all trusted prerequisites exist;
6. supervise an unexpectedly exited `tunnel-client` process with bounded exponential backoff;
7. supervise the desktop shell and Runtime Host with a separate Host Guardian process;
8. record bounded power, possible sleep/stall, and Tunnel loss/recovery diagnostics.

The connector restart delays are bounded and currently progress through:

```text
2s -> 5s -> 10s -> 30s -> 60s -> 120s -> 300s maximum
```

The official connector remains responsible for recovery while its process is alive and the network route changes. Sovereign's supervisor handles connector-process exit, explicit stop, credential rotation, workspace change, and application shutdown.

The Host Guardian is a second, smaller Node process outside the Tauri shell. The shell writes an authenticated per-launch control file under the app-data `guardian` directory. A normal tray **Exit** marks the shutdown intentional; an unexplained shell exit or a failed Runtime Host process/protocol health check causes a full shell restart. The Guardian persists a bounded restart history and opens its circuit after five restart attempts inside ten minutes. Its latest outcome is written to `guardian/last-incident.json` for local diagnosis. This prevents a bad build or deterministic startup failure from creating an infinite restart loop.

The main-window close button no longer exits the application in normal packaged use. It hides the window to the notification area while the Runtime Host, Gateway, Tunnel, and managed work remain active. Use the tray **Exit** action when the entire host should shut down.

The host-availability monitor samples power source, battery status, system uptime, and a monotonic five-second heartbeat. A heartbeat gap of 20 seconds or more is retained as a **possible sleep/resume or severe host stall**, not an exact power event. After such a gap Sovereign immediately refreshes Tunnel state. The monitor also records Ready-to-loss and loss-to-Ready transitions, observed outage duration, reconnect attempt, and next retry time. Up to 32 bounded non-secret events are kept in `host-availability.json` beneath the application data root.

## Prerequisites for restart-safe readiness

The UI reports **Unattended after sign-in** only when all of these are true:

- Windows login startup points at the currently running executable;
- an authorized workspace is saved;
- unattended startup is bound to that exact workspace root and the remembered L1-L3 selection is bound to the same root;
- Gateway auto-start is enabled;
- `tunnel-client.exe` is available and its SHA-256 is locally trusted;
- a valid Tunnel ID is saved;
- a Tunnel runtime key is available from Windows-protected storage;
- Tunnel auto-start and connector restart supervision are enabled;
- every configured primary or backup control-plane proxy is available from Windows-protected storage.

A portable build can be registered, but its folder must remain at exactly the same path. An installed build is preferred for a remote deployment because its executable path is stable.

## Optional outbound control-plane routing

**ChatGPT Connection → Primary OpenAI control-plane proxy** accepts an HTTP or HTTPS proxy URL supported by the official connector. This single-route mode remains the default when the destination network requires a proxy.

In **Full** interface mode, Sovereign can also store a protected backup proxy. Classified failover is intended only when primary and backup are genuinely independent endpoints or exits; two ports owned by the same local proxy process are not automatically independent failure domains. Direct fallback is disabled by default and requires explicit opt-in because it may change egress location and service reachability.

Sovereign applies the active route only to the connector's OpenAI control-plane requests:

```text
CONTROL_PLANE_HTTP_PROXY=env:SCR_TUNNEL_CONTROL_PLANE_PROXY_URL
```

The local MCP route remains direct:

```text
MCP_SERVER_URL=http://127.0.0.1:<ephemeral-port>/mcp
```

Consequences:

- it is not a system-wide VPN setting;
- it does not proxy local file, Git, terminal, Python, browser, or desktop traffic;
- it does not publish the local Gateway;
- credentials embedded in proxy URLs are never displayed back to the renderer;
- at rest, primary and backup proxy URLs are stored only as Windows-DPAPI-protected ciphertext;
- if Windows protection fails, a proxy remains memory-only for that application session and plaintext is not written to `settings.json`;
- a backup route is tried only after two confirmed, high-confidence control-plane transport failures on the active route;
- authentication, Tunnel identity, local-MCP, connector, and unknown failures stop for local attention and do not rotate proxies;
- a generic `/readyz` failure alone is not treated as proxy failure;
- route dwell, cooldown, switch-budget, and circuit-open controls prevent endless flapping;
- when every configured remote route fails, the loopback Gateway remains running and the ChatGPT Connection UI reports the remote-route circuit.

Network connectivity and service-region policy are separate concerns. A proxy can provide a network route; it does not change the service provider's account, region, or acceptable-use requirements. Verify the current OpenAI supported-country list and Secure MCP Tunnel documentation before deployment.

Official references:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://platform.openai.com/docs/supported-countries
- https://help.openai.com/en/articles/7947663-chatgpt-supported-countries

## Authority after restart

Sovereign persists the selected profile together with the exact normalized authorized workspace root. L1/L2/L3 are stored directly. L4 is stored only as a current-user Windows-DPAPI-protected grant after a local warning confirmation, while the previous L1-L3 profile is retained as the fallback. A fresh launch restores the selected profile only when the saved permission binding matches the current workspace. A stale or externally altered workspace mismatch fails closed to **L1 Observe**, clears unattended access, and rewrites the safe binding. A missing, corrupt, unreadable, or mismatched L4 grant falls back to the remembered L1-L3 profile.

Changing the workspace through the trusted local picker preserves the selected L1-L3 profile for the newly authorized folder but clears the old workspace-restore binding. Workspace restore and permission are independent settings: enabling or disabling restore never promotes, demotes, or replaces the active L1-L4 permission. L1 can therefore remain active while the exact authorized workspace is restored after sign-in; write-capable unattended work still requires the operator to select L2, L3, or L4 explicitly.

Remote Host Mode deliberately does not persist:

- any L3 single-use approval decision;
- direct-tool session approvals;
- plaintext L4 authorization material.

A restored L3 profile means only that L1 and L2 tools may run directly and L3 tools are eligible to ask for approval. Every PowerShell, Python, browser-control, workflow, desktop-control, deletion, or other consequential call still requires a fresh native desktop approval. A restored L4 profile requires the locally confirmed DPAPI-protected exact-workspace grant; revoking L4 returns to the remembered L1-L3 profile and clears the protected grant.

For consequential PowerShell, Python, browser-control, workflow, or desktop-control work, choose one of these operating models:

- an onsite person reviews the compact L3 approval window;
- the owner locally enables and explicitly remembers L4 for the exact workspace, accepting that its valid current-user DPAPI grant can restore after sign-in;
- explicitly select L2 and structure remote work around contained file/Git/validation tools. Workspace restore by itself does not grant L2.

## Operational limits

Remote Host Mode currently starts **after a Windows user signs in**. It is not a pre-login Windows service.

The host must remain:

- powered on;
- signed in;
- connected to a usable outbound network;
- awake.

Closing the main window hides Sovereign to the notification area and keeps its Runtime Host, Gateway, Tunnel, and active managed processes alive. Choosing tray **Exit** intentionally shuts down the full tree and tells the Guardian not to restart it. The current version still does not inhibit Windows sleep, start before Windows sign-in, or recover a powered-off computer. Its availability monitor can diagnose a possible sleep/stall gap only after the process resumes.

Sovereign is also not an offline job broker. When the host or Tunnel is offline, ChatGPT cannot enqueue a new task for later delivery. Persisted run records describe work already accepted locally; interrupted work is not automatically resumed as a new remote task.

## Deployment checklist

Before leaving a host at another location:

1. Install Sovereign to a stable current-user path, or place the portable folder at a permanent path.
2. Sign in as the Windows user that will run Sovereign.
3. Authorize only the intended workspace.
4. Configure and trust the official connector.
5. Save the Tunnel ID and runtime key; confirm the UI says the key is Windows-protected.
6. Configure a primary outbound control-plane proxy only when the local network requires one; confirm it is Windows-protected. Add a protected backup only when it represents a genuinely independent endpoint, and leave direct fallback off unless the deployment explicitly accepts that route.
7. Enable the unattended host and confirm the UI identifies the exact bound workspace.
8. Set Windows sleep to an operating policy appropriate for an always-reachable host.
9. Reboot, sign in, and verify that Sovereign starts hidden/minimized, remains available from the notification area, and reports Tunnel **Ready**.
10. From the remote ChatGPT Web session, invoke a harmless read-only tool such as `system.info`.
11. Test connector-process termination, Runtime Host termination, router interruption, and recovery. When backup routing is configured, force a real primary-route transport failure and verify primary retry, backup selection, old-process exit, Tunnel Ready, and a remote `system.info` call. Inspect `guardian/last-incident.json` after a host restart and `host-availability.json` after a network interruption or sleep/resume exercise.
12. Confirm that closing the window leaves the host online and that tray **Exit** performs a real intentional shutdown.
13. Confirm the onsite person knows how to reopen or stop Sovereign. If remote work requires L3, they must also understand how to approve or deny the native prompt.

A real deployment should be tested on the actual destination ISP and network path. A successful Tunnel on a different network does not prove that the destination route, proxy, firewall, DNS, power policy, or Windows update behavior is reliable.

## Troubleshooting signals

The desktop distinguishes:

- connector unavailable or digest not trusted;
- missing Tunnel ID or runtime key;
- key/proxy stored only for the current session;
- connector running but not ready;
- connector or route retry scheduled, including attempt number and next retry time;
- active primary, backup, or direct route; per-route state; last classified failure; and an open remote-route circuit;
- Host Guardian restart incidents and an open crash-loop circuit in `guardian/last-incident.json`, and why the Runtime Host failed, with its last stderr lines, in `guardian/last-runtime-failure.json`;
- current power source, the latest possible sleep/stall gap, Tunnel loss/retry/recovery timing, and the bounded `host-availability.json` event tail;
- Tunnel ready but no ChatGPT MCP session connected.

**Settings → Diagnostics** shows the real executable path and whether the current shell is installed, portable, development, or legacy Electron. This prevents configuring Windows login startup for one build while manually testing another.
