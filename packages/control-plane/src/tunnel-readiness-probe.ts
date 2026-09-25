/**
 * Asks a connector's loopback health endpoints whether it is ready and when it
 * last completed a control-plane poll. The answer keeps "did not answer in
 * time" apart from a failure: on a host saturated by other work a healthy
 * connector answers late, and reading that as a broken connector recycled
 * working tunnels and cut every request riding on them.
 */

import { readBoundedResponseBody } from "./secure-tunnel-support.js";
import { readLastSuccessfulPollMs } from "./tunnel-control-plane-poll.js";

export const CONNECTOR_PROBE_TIMEOUT_MS = 5_000;

export type ConnectorReadinessAnswer =
  | { readonly kind: "ready"; readonly lastSuccessfulPollMs: number | null }
  | { readonly kind: "not-ready"; readonly statusCode: number; readonly body: string }
  | { readonly kind: "unanswered"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string; readonly statusCode?: number };

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function askConnectorReadiness(
  healthUrl: string,
  timeoutMs = CONNECTOR_PROBE_TIMEOUT_MS,
): Promise<ConnectorReadinessAnswer> {
  const unanswered = (endpoint: string): ConnectorReadinessAnswer => ({
    kind: "unanswered",
    detail: `The connector did not answer ${endpoint} within ${timeoutMs} ms.`,
  });
  let response: Response;
  try {
    response = await fetch(`${healthUrl}/readyz`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return isTimeout(error) ? unanswered("/readyz") : { kind: "failed", detail: describe(error) };
  }
  if (!response.ok) {
    try {
      return { kind: "not-ready", statusCode: response.status, body: await readBoundedResponseBody(response) };
    } catch (error) {
      return {
        kind: "failed",
        statusCode: response.status,
        detail: `Could not read the local /readyz response: ${describe(error)}`,
      };
    }
  }
  await response.body?.cancel().catch(() => undefined);
  try {
    return { kind: "ready", lastSuccessfulPollMs: await readLastSuccessfulPollMs(healthUrl, timeoutMs) };
  } catch (error) {
    return isTimeout(error) ? unanswered("/metrics") : { kind: "failed", detail: describe(error) };
  }
}
