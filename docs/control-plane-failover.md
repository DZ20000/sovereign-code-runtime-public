# Secure MCP Tunnel control-plane failover contract

## Status

Classified primary/backup OpenAI control-plane failover is implemented as an advanced Remote Host feature. The normal default remains one route: direct when no proxy is configured, or one Windows-protected primary proxy when the destination network requires it. `MCP_SERVER_URL` always stays direct to the loopback Sovereign Gateway.

The generation-safe connector supervisor runs every attempt in a per-controller instance directory with generation-bound health and PID files. Callbacks and health probes are bound to the exact generation and child identity; inherited proxy/connector environment is cleared before Sovereign injects managed values; the previous process tree is retired before another route launches; and connector output is buffered by line, redacted, then bounded.

The structured failure classifier consumes bounded, already-redacted connector log lines, `/readyz` status/body evidence, spawn/process errors, health-file failures, and local health-probe failures. The resulting `scr.tunnel-failure/v1` diagnostic is exposed in desktop state. Only explicit, high-confidence control-plane transport evidence is marked route-switch eligible. Authentication, Tunnel identity, local-MCP, generic connector, and unknown failures stop for local attention without trying another proxy. Generic `/readyz` non-readiness does not establish transport failure.

Primary and backup proxy URLs use the existing Windows-protected ciphertext or memory-only fallback boundary. A backup can be configured only when a primary exists. Direct fallback is a separate non-secret opt-in and defaults off because it may change egress location and service reachability. Clearing the primary atomically clears the dependent backup and direct-fallback settings.

The route coordinator owns retry/switch timing above the single-connector supervisor. It retries the same route after the first confirmed transport failure, switches after the configured threshold, enforces dwell/cooldown/switch-budget limits, opens only the remote-route circuit when alternatives are exhausted, and leaves the local Gateway running. Stop, credential/configuration changes, workspace changes, Gateway shutdown, and application shutdown invalidate pending route generations and timers.

Implementation order and status:

```text
1. pure deterministic policy and tests                 complete
2. generation-bound process supervisor and tests       complete
3. structured failure classification and diagnostics   complete
4. protected multi-route configuration                 complete
5. classified route-launch coordinator                 complete
6. full-mode route UI                                   complete
7. deterministic process-level route tests              complete
8. real endpoint-failure acceptance test                pending
```

Do not combine this work with signed updates, multi-project support, or offline task delivery.

## Deployment modes

### Mode A — stable local proxy endpoint

Recommended default:

```text
Sovereign -> one fixed local proxy endpoint
local proxy software -> upstream node health and failover
```

### Mode B — Sovereign-managed independent endpoints

Advanced mode only when primary and backup are genuinely independent services, devices, or exits. Two ports on one local proxy process are not automatically independent failure domains.

Direct fallback is disabled by default and requires explicit operator opt-in.

## Invariants

1. `MCP_SERVER_URL` always points directly to the active loopback Sovereign `/mcp` endpoint.
2. Proxy selection applies only to the official OpenAI control-plane route.
3. `/readyz` failure alone is not proxy-transport evidence.
4. Only confirmed `transport` failure may switch routes automatically.
5. `auth`, `identity`, `local-mcp`, and `connector` failures never switch routes. An `unknown` failure on a route that never reached readiness advances to the next configured route before attention.
6. One connector attempt has one generation, one child identity, and one unique health-file path.
7. Stale generations cannot mutate state or launch another process.
8. The old process tree must be confirmed exited before the next generation starts.
9. Stop, credential rotation, workspace change, and shutdown invalidate the generation and cancel pending launches.
10. When all remote routes fail, the local Gateway stays running and the remote-route circuit opens.
11. Diagnostics are redacted before entering logs, UI state, or persisted evidence.
12. A connector log line never ends a ready attempt by itself, nor one whose connector says it is retrying.
13. Attention retries after cooldown through the normal refresh loop; a network change shortens that wait. `auth` and `identity` still require local action.

## State model

```text
route id:
  primary | backup | direct

route state:
  disabled | untested | probing | ready | cooling-down | failed

lifecycle:
  stopped | running | needs-attention | circuit-open

failure class:
  transport | auth | identity | local-mcp | connector | unknown

attempt identity:
  generation | route | startedAt | readyAt
```

The pure reducer owns no process handles, files, timers, credentials, or network calls. Event timestamps are process-monotonic milliseconds supplied by the supervisor, not wall-clock time. Failure events accept only diagnostic reasons that have already passed secret redaction.

## Failure classification

- `transport`: route-specific control-plane network evidence. Eligible for switching.
- `auth`: runtime-key/account/permission failure. Requires attention; no switch.
- `identity`: Tunnel ID or association failure. Requires attention; no switch.
- `local-mcp`: local Gateway or MCP startup-probe failure. Repair locally; no switch.
- `connector`: process/executable failure without route-specific transport evidence. Retry the same route once, then require attention.
- `unknown`: fail closed to operator attention. A route that never reached readiness first advances to the next configured route, so one unusable proxy cannot mask a reachable direct route.

A generic readiness timeout is not enough to classify `transport`. An attempt that never becomes locally ready is bounded by the existing first-poll deadline. After readiness, three consecutive explicit failed checks exhaust the recovery window. Both become actionable `unknown` evidence without guessing a failed route; the route coordinator can recover instead of leaving the connector running forever. All readiness callers share this accounting, and a successful check resets it.

`auth` requires explicit HTTP status evidence: a `status` or `status_code` field, `HTTP 401`, `401 Unauthorized`, or `returned 403`. Numeric connector fields such as `retry_in_ms` and `timeout_ms` never imply a status code.

A connector line that announces its own retry (`retry_in_ms`, `backing off`, `will retry`) is advisory, judged on the whole line rather than the stored excerpt. Advisory transport evidence stays in the log tail, outside the decisive failure slot, so it cannot hide a later failed control-plane poll or health probe. Explicit `auth`, `identity`, and `local-mcp` evidence still stops for attention because it cannot resolve itself.

Once an attempt is ready, its control-plane polls are the authority on the route, so a transport line it logs is advisory as well: a connector that keeps completing polls is healthy whatever one request did. Recycling on such lines cut every request in flight and ended the MCP sessions riding on the tunnel. A route that has really gone stops completing polls, and the readiness probe fails it once the last successful poll is older than the freshness window. Escalation after readiness therefore comes from stale polls, consecutive `/readyz` failures, or process exit.

A local health check that gets no answer within its timeout (five seconds by default) is `unanswered`, not failed: on a host saturated by builds a healthy connector answers late, and recycling it for that cut every request in flight. An unanswered check leaves the attempt's phase alone. Only a connector that stays silent for longer than the poll freshness window is treated as a failed health probe, and the usual consecutive-failure rule then recycles it. A refused connection, an unreadable response, or a `/metrics` error is still a failure at once.

Dispatcher lines report one command's exchange with the local MCP server (`dispatcher received MCP upstream error; posted error response to control plane`, `failed to post response to control plane`). They name the control plane only as where the reply went, so they classify as `unknown` with low confidence and never count toward a route failure.

Local readiness does not prove remote control-plane reachability. The poll metric may expose whole Unix seconds, so a timestamp in the same wall-clock second as the generation-bound connector startup is accepted as belonging to that attempt; an earlier second is not. Brief Ready transitions retain transport failure counts; a route must remain Ready for the minimum dwell interval before a subsequent failure starts a fresh incident.

## Initial anti-flap policy

```text
consecutive confirmed transport failures before switch: 2
same-route retry delay:                                  2 seconds
route-switch launch delay:                               2 seconds
minimum Ready dwell:                                     5 minutes
cooldown for route being left:                           5 minutes
switch accounting window:                               30 minutes
maximum switches in window:                              4
connector same-route retry limit:                        1
```

A hard transport failure may bypass minimum dwell, but not the two-failure threshold. With automatic reconnection enabled, a transport circuit and recoverable attention state retry after the route cooldown through the Shell's existing refresh loop. A network change allows an earlier retry after the route-switch delay and rebuilds a ready connection on its current route. A change received during cooldown does not disable subsequent periodic recovery. Recovery preserves the rolling switch budget and counts a return to a different route as a switch. Manual Stop, disabled automatic reconnection, and explicit authorization or identity failures do not trigger automatic recovery.

## Process-supervisor contract

For every launch:

```text
generation += 1
health file = secure-tunnel/attempt-<generation>-health-url.txt
spawn one trusted connector
bind callbacks to generation + exact child identity
```

Before replacement, supersede the generation, terminate the exact old process tree, wait for confirmed exit, and only then launch the selected route. Late events and health-file writes from older generations are ignored.

The accepted health URL must be loopback HTTP without credentials, query, or fragment, and the file must belong to the current generation.

## Child environment contract

Remove inherited proxy variables case-insensitively before adding route-specific values, including common and connector-specific forms such as:

```text
HTTP_PROXY
HTTPS_PROXY
ALL_PROXY
NO_PROXY
CONTROL_PLANE_HTTP_PROXY
TUNNEL_CLIENT_HTTP_PROXY
MCP_HTTP_PROXY
GLOBAL_AGENT_HTTP_PROXY
npm_config_proxy
npm_config_https_proxy
```

Then explicitly set:

```text
NO_PROXY=127.0.0.1,localhost,::1
```

For a proxy route, inject the protected proxy through a child-only environment reference. For direct mode, inject no control-plane proxy variable. Credentials remain out of command-line arguments.

## Diagnostic redaction

Before connector output reaches `logTail`, redact exact runtime/Gateway/proxy secret values, URL credentials, authorization header values, sensitive environment assignments, and generic Bearer tokens. Redaction happens before truncation.

## Pure policy effects

```text
launch route/generation after bounded delay
hold current state
require operator attention
open circuit
stop and invalidate generation
ignore stale event
```

## Required deterministic tests

```text
start chooses first enabled route
stale generation events are ignored
first transport failure retries same route
second transport failure switches to backup
minimum dwell blocks soft switching
hard transport may bypass dwell after threshold
auth/identity/local-MCP/unknown never switch
connector failure retries once then requires attention
Stop invalidates generation
cooling route is skipped
all alternatives unavailable opens circuit
switch budget exhaustion opens circuit
manual reset starts a fresh generation
direct is absent unless explicitly configured
health filenames are generation-bound
inherited proxy variables are removed
loopback NO_PROXY is explicit
credential-bearing diagnostics are redacted
```

## Integration acceptance

A final acceptance test must force a real primary-route transport failure, classify it correctly, confirm the old process tree exits, start a backup generation, reach Tunnel Ready, and complete a remote `system.info` call on the expected device/project. Authentication, identity, and local-MCP failures must prove that no route switch occurs.
