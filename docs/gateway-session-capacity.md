# Gateway MCP session capacity

Sovereign's local Gateway limits concurrent MCP sessions to protect memory and to keep abandoned web sessions from accumulating indefinitely. The defaults remain conservative, while a trusted local operator can tune the policy through Runtime Host environment variables.

## Configuration

```text
SCR_GATEWAY_MAX_SESSIONS          1..256 sessions
SCR_GATEWAY_RECLAIM_IDLE_MS       10..86400000 milliseconds
SCR_GATEWAY_SESSION_IDLE_MS       10..86400000 milliseconds
SCR_GATEWAY_SESSION_SWEEP_MS      10..86400000 milliseconds
```

The reclaim and sweep intervals may not exceed the normal idle timeout. Invalid values fail Runtime Host startup rather than silently falling back.

Defaults:

```text
max sessions          128
capacity reclaim      5 minutes idle
normal idle expiry    30 minutes
idle sweep            60 seconds
```

Recommended high-capacity local policy for many parallel ChatGPT Web sessions:

```text
SCR_GATEWAY_MAX_SESSIONS=256
SCR_GATEWAY_RECLAIM_IDLE_MS=60000
SCR_GATEWAY_SESSION_IDLE_MS=1800000
SCR_GATEWAY_SESSION_SWEEP_MS=30000
```

The same names are used by the packaged Runtime Host and the standalone Gateway. Both paths resolve them through the single shared policy implementation in `packages/runtime-core`; Runtime Host must not maintain a second parser or a different default set. Environment changes take effect only after the owning Runtime Host process restarts or rolls to a newly launched candidate.

## HTTP 429 meaning

The Gateway returns HTTP 429 only when a new MCP initialization would exceed the configured session capacity and no safely reclaimable idle session exists. It first attempts to reclaim sessions with no in-flight requests that have exceeded the configured reclaim interval. The response includes `Retry-After` and bounded capacity details.

This is separate from Windows notification delivery and separate from ChatGPT plan, token, or conversation-length limits. The Windows notification path has no HTTP-style content deduplication or rolling capacity domain.

Increasing the ceiling does not remove authentication, principal ownership, idle expiry, in-flight request protection, or the maximum hard ceiling of 256 sessions.
