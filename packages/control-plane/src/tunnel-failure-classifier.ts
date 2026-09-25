import type { ControlPlaneFailureClass } from "./control-plane-failover.js";

const MAX_EVIDENCE_CHARACTERS = 512;

export type TunnelFailureEvidenceSource =
  | "readyz"
  | "connector-log"
  | "spawn"
  | "process"
  | "health-file"
  | "health-probe"
  | "readiness-timeout"
  | "control-plane-poll";

export type TunnelFailureConfidence = "low" | "medium" | "high";

export interface TunnelFailureEvidence {
  readonly source: TunnelFailureEvidenceSource;
  /** Diagnostic text that has already passed secret redaction. */
  readonly redactedText: string;
  readonly statusCode?: number;
  readonly controlPlaneProxyConfigured?: boolean;
}

export interface TunnelFailureClassification {
  readonly schemaVersion: "scr.tunnel-failure/v1";
  readonly failureClass: ControlPlaneFailureClass;
  readonly source: TunnelFailureEvidenceSource;
  readonly confidence: TunnelFailureConfidence;
  readonly routeSwitchEligible: boolean;
  readonly evidenceCode: string;
  readonly summary: string;
  readonly detail: string;
  readonly statusCode: number | null;
}

export interface TunnelFailureDiagnostic extends TunnelFailureClassification {
  readonly observedAt: string;
}

function boundedEvidence(value: string): string {
  const normalized = value.replace(/[\r\n\0]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "No additional diagnostic detail was reported.";
  }
  return normalized.length <= MAX_EVIDENCE_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_EVIDENCE_CHARACTERS - 1)}…`;
}

function result(
  evidence: TunnelFailureEvidence,
  failureClass: ControlPlaneFailureClass,
  confidence: TunnelFailureConfidence,
  evidenceCode: string,
  summary: string,
  routeSwitchEligible = false,
): TunnelFailureClassification {
  return {
    schemaVersion: "scr.tunnel-failure/v1",
    failureClass,
    source: evidence.source,
    confidence,
    routeSwitchEligible: routeSwitchEligible && failureClass === "transport" && confidence === "high",
    evidenceCode,
    summary,
    detail: boundedEvidence(evidence.redactedText),
    statusCode: evidence.statusCode ?? null,
  };
}

function classifyReadyz(evidence: TunnelFailureEvidence): TunnelFailureClassification {
  const text = evidence.redactedText.toLowerCase();
  if (text.includes("oauth discovery pending")) {
    return result(
      evidence,
      "unknown",
      "low",
      "readyz-oauth-discovery-pending",
      "OAuth discovery is still pending; no route failure has been established.",
    );
  }
  if (text.includes("oauth discovery failed")) {
    return result(
      evidence,
      "local-mcp",
      "high",
      "readyz-oauth-discovery-failed",
      "The local MCP OAuth discovery gate failed.",
    );
  }
  if (text.includes("mcp probe failed")) {
    return result(
      evidence,
      "local-mcp",
      "high",
      "readyz-mcp-probe-failed",
      "The local MCP startup probe failed.",
    );
  }
  return result(
    evidence,
    "unknown",
    "low",
    "readyz-nonready-unclassified",
    `Tunnel readiness returned HTTP ${evidence.statusCode ?? "unknown"} without route-specific transport evidence.`,
  );
}

function hasControlPlaneContext(text: string): boolean {
  return /(?:control[- ]?plane|api\.openai\.com|\/v1\/tunnels|\bpoll(?:ing)?\b|tunnel metadata)/iu.test(text);
}

function hasProxyContext(text: string): boolean {
  return /(?:proxy|proxyconnect|control_plane_http_proxy|control-plane route)/iu.test(text);
}

function hasTransportFailure(text: string): boolean {
  return /(?:no such host|name resolution|dns lookup|network is unreachable|connection refused|connectex|connection reset|connection aborted|tls handshake timeout|i\/o timeout|dial tcp|proxyconnect|unable to connect|connection timed out|timeout awaiting response headers|temporary failure in name resolution|\beof\b|broken pipe|use of closed network connection|server sent goaway|stream error|context deadline exceeded|forcibly closed)/iu.test(text);
}

/**
 * Only explicit HTTP status evidence may imply an authorization failure.
 * Connector output is JSON that also carries numeric fields such as
 * `retry_in_ms` and `timeout_ms`, so a bare number is never a status code.
 */
function hasAuthorizationStatus(text: string, statusCode: number | undefined): boolean {
  if (statusCode === 401 || statusCode === 403) {
    return true;
  }
  return /(?:\bhttp\/\d(?:\.\d)?\s+(?:401|403)\b|\bhttp\s+(?:401|403)\b|\bstatus(?:[ _-]?code)?"?\s*[:=]\s*"?(?:401|403)\b|\b(?:401|403)\s+(?:unauthorized|forbidden)\b|\breturned\s+(?:401|403)\b)/iu.test(text);
}

const CONNECTOR_SELF_RETRY_PATTERN = /(?:retry_in_ms|retrying in|will retry|backing off|back-?off)/iu;

/**
 * True when the connector's own output states that it is going to retry. Such a
 * line is advisory: the process is still running and recovering by itself, so
 * it must not be treated as a terminal route failure while it stays alive.
 */
export function connectorReportsOwnRetry(evidence: {
  readonly source: TunnelFailureEvidenceSource;
  readonly detail: string;
}): boolean {
  return (
    evidence.source === "connector-log" &&
    CONNECTOR_SELF_RETRY_PATTERN.test(evidence.detail)
  );
}

/**
 * The dispatcher relays one command to the local MCP server and posts the reply
 * back. Its lines name the control plane only as where that reply went, so an
 * error in one of them is about a single request, never about the route.
 */
function isDispatcherRequestReport(text: string): boolean {
  return /(?:"component"\s*:\s*"dispatcher"|\bcomponent=dispatcher\b|\bdispatcher (?:received|failed|delivered|forwarded|terminated|rejected|acknowledged)\b|\bfrom MCP server\b|\bfailed to (?:post|forward) [^"]*\bto control plane\b)/iu.test(text);
}

function classifyConnectorLog(evidence: TunnelFailureEvidence): TunnelFailureClassification {
  const text = evidence.redactedText;
  const lower = text.toLowerCase();

  if (isDispatcherRequestReport(text)) {
    return result(
      evidence,
      "unknown",
      "low",
      "log-dispatcher-request",
      "One relayed MCP request failed; the control-plane route is not implicated.",
    );
  }

  if (
    /(?:invalid tunnel id|tunnel id is required|unknown tunnel|tunnel (?:was )?not found|workspace association|tunnel workspace mismatch|connector selected.*different tunnel)/iu.test(text)
  ) {
    return result(
      evidence,
      "identity",
      "high",
      "log-tunnel-identity",
      "The Tunnel identity or workspace association is invalid.",
    );
  }

  if (
    lower.includes("unsupported_country_region_territory") ||
    (hasControlPlaneContext(text) &&
      (hasAuthorizationStatus(text, evidence.statusCode) ||
        /(?:unauthorized|forbidden|invalid api key|runtime key|tunnels use|not authorized|permission denied)/iu.test(text)))
  ) {
    return result(
      evidence,
      "auth",
      "high",
      "log-control-plane-authorization",
      "The control plane rejected the runtime credential, permission, or service policy.",
    );
  }

  if (
    /(?:mcp probe failed|oauth discovery failed|mcp startup probe|unsupported_channel|mcp server connectivity|mcp server url is required)/iu.test(text) ||
    (/(?:127\.0\.0\.1|localhost|\[?::1\]?)/u.test(text) && hasTransportFailure(text) &&
      !hasProxyContext(text) && !hasControlPlaneContext(text))
  ) {
    return result(
      evidence,
      "local-mcp",
      "high",
      "log-local-mcp",
      "The local MCP target or its OAuth/startup probe failed.",
    );
  }

  if (
    hasTransportFailure(text) &&
    (hasProxyContext(text) || hasControlPlaneContext(text))
  ) {
    return result(
      evidence,
      "transport",
      "high",
      "log-control-plane-transport",
      evidence.controlPlaneProxyConfigured === true
        ? "The configured control-plane proxy reported a route-specific transport failure."
        : "The direct control-plane route reported a route-specific transport failure.",
      true,
    );
  }

  return result(
    evidence,
    "unknown",
    "low",
    "log-unclassified",
    "Connector output did not establish a safe failure classification.",
  );
}

export function classifyTunnelFailureEvidence(
  evidence: TunnelFailureEvidence,
): TunnelFailureClassification {
  switch (evidence.source) {
    case "readyz":
      return classifyReadyz(evidence);
    case "connector-log":
      return classifyConnectorLog(evidence);
    case "spawn":
      return result(
        evidence,
        "connector",
        "high",
        "connector-spawn-failed",
        "The local connector process could not be started.",
      );
    case "process":
      return result(
        evidence,
        "connector",
        "high",
        "connector-process-failed",
        "The local connector process exited or emitted a process error.",
      );
    case "health-file":
      return result(
        evidence,
        "connector",
        "medium",
        "connector-health-file-invalid",
        "The connector health-file handshake was missing, stale, or invalid.",
      );
    case "health-probe":
      return result(
        evidence,
        "connector",
        "medium",
        "connector-health-probe-failed",
        "The local connector health endpoint could not be queried.",
      );
    case "readiness-timeout":
      return result(evidence, "unknown", "high", "connector-readiness-timeout",
        "The connector exhausted its startup or readiness recovery window.");
    case "control-plane-poll":
      // The connector is up and its local side answers, so what is missing is
      // the route to the control plane: a transport failure, and one that
      // warrants trying the next route rather than waiting on this one.
      return result(
        evidence,
        "transport",
        "high",
        "control-plane-poll-stale",
        "The connector is running but is not completing control-plane polls on this route.",
        true,
      );
  }
}

export function tunnelFailureClassificationPriority(
  classification: TunnelFailureClassification,
): number {
  // An exhausted readiness window outranks provisional local-handshake errors,
  // while explicit transport, authorization and identity evidence still wins.
  if (classification.source === "readiness-timeout") return 40;
  const classWeight: Readonly<Record<ControlPlaneFailureClass, number>> = {
    auth: 80,
    identity: 80,
    "local-mcp": 80,
    transport: 60,
    connector: 20,
    unknown: 10,
  };
  const confidenceWeight: Readonly<Record<TunnelFailureConfidence, number>> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  return classWeight[classification.failureClass] + confidenceWeight[classification.confidence];
}
