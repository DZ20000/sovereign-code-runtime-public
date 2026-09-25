/**
 * Evidence that the connector is actually talking to the OpenAI control plane.
 *
 * `/readyz` answers for the connector process and its local MCP channel only.
 * It stays 200 on a route that cannot reach the control plane at all, which is
 * how a DNS-poisoned direct route passed for healthy for seven hours while no
 * request reached the machine. The connector's own
 * `health --require-control-plane-poll` reads this metric for the same reason.
 */
const LAST_SUCCESSFUL_POLL_METRIC = "commands_poll_last_successful_timestamp_seconds";

/** A long poll holds for up to 30s, so a working poller succeeds well inside this. */
export const CONTROL_PLANE_POLL_FRESHNESS_MS = 90_000;

/**
 * How long a new connector may run without ever completing a poll before its
 * route counts as failed. The metric moves only when a poll completes, and a
 * long poll with nothing queued holds for up to 30s, so a healthy connector can
 * legitimately show no completed poll for its first half minute. The deadline
 * covers two full cycles with margin; beyond it the route is unreachable.
 */
export const CONTROL_PLANE_FIRST_POLL_DEADLINE_MS = 75_000;

/** The metric sits near the top of the exposition, so the scan stops long before this. */
const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

export function lastSuccessfulPollMs(line: string): number | null {
  if (!line.startsWith(LAST_SUCCESSFUL_POLL_METRIC)) return null;
  const value = Number(line.trim().split(/\s+/u).pop());
  return Number.isFinite(value) && value > 0 ? value * 1_000 : null;
}

/**
 * Reads `/metrics` only until the poll timestamp appears. The exposition runs
 * to hundreds of kilobytes of histograms and is probed every few seconds, so
 * the whole body is never buffered.
 */
export async function readLastSuccessfulPollMs(
  healthUrl: string,
  timeoutMs = 2_000,
): Promise<number | null> {
  const response = await fetch(`${healthUrl}/metrics`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Connector /metrics returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder();
  let pending = "";
  let scanned = 0;
  try {
    while (scanned < MAX_SCANNED_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      scanned += chunk.value.byteLength;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const found = lastSuccessfulPollMs(line);
        if (found !== null) return found;
      }
    }
    return lastSuccessfulPollMs(pending);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export type ControlPlanePollVerdict =
  | { readonly ready: true }
  | { readonly ready: null }
  | { readonly ready: false; readonly detail: string };

/**
 * A new connector gets the benefit of the doubt until its first-poll deadline:
 * its first long poll may still be open, and treating that as a failure kills
 * healthy routes on every start. After the deadline it must have polled, and
 * once it has, polls must stay recent. Anything short of that means the route
 * has failed and should be abandoned for the next one.
 */
export function judgeControlPlanePoll(
  lastSuccessfulAtMs: number | null,
  attemptStartedAtMs: number,
  nowMs: number,
  timing: { readonly deadlineMs: number; readonly freshnessMs: number } = {
    deadlineMs: CONTROL_PLANE_FIRST_POLL_DEADLINE_MS,
    freshnessMs: CONTROL_PLANE_POLL_FRESHNESS_MS,
  },
): ControlPlanePollVerdict {
  // The connector metric may be emitted as whole Unix seconds. Because the
  // health endpoint is bound to the exact current child generation, a timestamp
  // from the same wall-clock second as startup belongs to this attempt even when
  // its millisecond representation sorts just before attemptStartedAtMs.
  const attemptStartedAtPrecisionFloorMs = Math.floor(attemptStartedAtMs / 1_000) * 1_000;
  if (lastSuccessfulAtMs !== null &&
      lastSuccessfulAtMs >= attemptStartedAtPrecisionFloorMs &&
      nowMs - lastSuccessfulAtMs <= timing.freshnessMs) {
    return { ready: true };
  }
  if (lastSuccessfulAtMs === null || lastSuccessfulAtMs < attemptStartedAtPrecisionFloorMs) {
    const waited = nowMs - attemptStartedAtMs;
    if (waited <= timing.deadlineMs) return { ready: null };
    return {
      ready: false,
      detail: `The connector has not completed a control-plane poll in ${Math.round(waited / 1_000)}s on this route.`,
    };
  }
  return {
    ready: false,
    detail: `The last successful control-plane poll was ${Math.round((nowMs - lastSuccessfulAtMs) / 1_000)}s ago.`,
  };
}
