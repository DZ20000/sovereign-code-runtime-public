const ROUTE_IDS = ["primary", "backup", "direct"] as const;

export type ControlPlaneRouteId = typeof ROUTE_IDS[number];
export type ControlPlaneRouteStatus =
  | "disabled"
  | "untested"
  | "probing"
  | "ready"
  | "cooling-down"
  | "failed";
export type ControlPlaneFailoverLifecycle =
  | "stopped"
  | "running"
  | "needs-attention"
  | "circuit-open";
export type ControlPlaneFailureClass =
  | "transport"
  | "auth"
  | "identity"
  | "local-mcp"
  | "connector"
  | "unknown";

export interface ControlPlaneFailoverPolicy {
  readonly routeOrder: readonly ControlPlaneRouteId[];
  readonly transportFailureThreshold: number;
  readonly connectorRetryLimit: number;
  readonly sameRouteRetryDelayMs: number;
  readonly routeSwitchDelayMs: number;
  readonly minimumDwellMs: number;
  readonly routeCooldownMs: number;
  readonly switchWindowMs: number;
  readonly maxSwitchesInWindow: number;
}

export const DEFAULT_CONTROL_PLANE_FAILOVER_POLICY: ControlPlaneFailoverPolicy = Object.freeze({
  routeOrder: Object.freeze(["primary", "backup"] as const),
  transportFailureThreshold: 2,
  connectorRetryLimit: 1,
  sameRouteRetryDelayMs: 2_000,
  routeSwitchDelayMs: 2_000,
  minimumDwellMs: 5 * 60_000,
  routeCooldownMs: 5 * 60_000,
  switchWindowMs: 30 * 60_000,
  maxSwitchesInWindow: 4,
});

export interface ControlPlaneRouteRuntimeState {
  readonly status: ControlPlaneRouteStatus;
  readonly consecutiveTransportFailures: number;
  readonly consecutiveConnectorFailures: number;
  readonly lastFailureClass: ControlPlaneFailureClass | null;
  readonly lastFailureAt: number | null;
  readonly lastReadyAt: number | null;
  readonly cooldownUntil: number | null;
}

export interface ControlPlaneFailoverState {
  readonly schemaVersion: "scr.control-plane-failover/v1";
  readonly lifecycle: ControlPlaneFailoverLifecycle;
  readonly activeRoute: ControlPlaneRouteId | null;
  readonly activeSince: number | null;
  readonly attemptGeneration: number;
  readonly routes: Readonly<Record<ControlPlaneRouteId, ControlPlaneRouteRuntimeState>>;
  readonly switchHistory: readonly number[];
  readonly circuitOpenedAt: number | null;
  readonly circuitReason: string | null;
}

export type ControlPlaneFailoverEvent =
  | { readonly type: "start"; readonly at: number }
  | { readonly type: "manual-reset"; readonly at: number }
  | { readonly type: "recover"; readonly at: number; readonly networkChanged?: boolean }
  | { readonly type: "stop"; readonly at: number; readonly reason?: string }
  | {
      readonly type: "attempt-ready";
      readonly at: number;
      readonly route: ControlPlaneRouteId;
      readonly generation: number;
    }
  | {
      readonly type: "attempt-failed";
      readonly at: number;
      readonly route: ControlPlaneRouteId;
      readonly generation: number;
      readonly failureClass: ControlPlaneFailureClass;
      readonly redactedReason: string;
      readonly hardTransport?: boolean;
    };

export type ControlPlaneFailoverEffect =
  | {
      readonly kind: "launch";
      readonly route: ControlPlaneRouteId;
      readonly generation: number;
      readonly delayMs: number;
      readonly cause: "start" | "manual-reset" | "same-route-retry" | "failover";
    }
  | { readonly kind: "stop"; readonly generation: number; readonly reason: string }
  | {
      readonly kind: "attention";
      readonly failureClass: ControlPlaneFailureClass;
      readonly reason: string;
    }
  | { readonly kind: "circuit-open"; readonly reason: string }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "hold"; readonly reason: string };

export interface ControlPlaneFailoverTransition {
  readonly state: ControlPlaneFailoverState;
  readonly effect: ControlPlaneFailoverEffect;
}

const PROXY_ENVIRONMENT_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "CONTROL_PLANE_HTTP_PROXY",
  "TUNNEL_CLIENT_HTTP_PROXY",
  "MCP_HTTP_PROXY",
  "HARPOON_HTTP_PROXY",
  "GLOBAL_AGENT_HTTP_PROXY",
  "PROXY_CHECK_INTERVAL",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "SCR_TUNNEL_CONTROL_PLANE_PROXY_URL",
  "CONTROL_PLANE_API_KEY",
  "CONTROL_PLANE_TUNNEL_ID",
  "CONTROL_PLANE_BASE_URL",
  "CONTROL_PLANE_URL_PATH",
  "CONTROL_PLANE_CLIENT_CERT",
  "CONTROL_PLANE_CLIENT_KEY",
  "CONTROL_PLANE_POLL_TIMEOUT",
  "CONTROL_PLANE_POLL_DEADLINE_GUARDRAIL",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "MCP_SERVER_URL",
  "MCP_SERVER_URLS",
  "MCP_COMMAND",
  "MCP_CLIENT_CERT",
  "MCP_CLIENT_KEY",
  "MCP_UNIX_SOCKET_PATH",
  "MCP_EXTRA_HEADERS",
  "MCP_DISCOVERY_EXTRA_HEADERS",
  "SCR_GATEWAY_AUTH_HEADER",
  "HEALTH_LISTEN_ADDR",
  "HEALTH_URL_FILE",
  "PID_FILE",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "LOG_HTTP_RAW_UNSAFE",
  "NO_COLOR",
]);

function emptyRoute(enabled: boolean): ControlPlaneRouteRuntimeState {
  return {
    status: enabled ? "untested" : "disabled",
    consecutiveTransportFailures: 0,
    consecutiveConnectorFailures: 0,
    lastFailureClass: null,
    lastFailureAt: null,
    lastReadyAt: null,
    cooldownUntil: null,
  };
}

function validateBoundedPositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function validatePolicy(policy: ControlPlaneFailoverPolicy): void {
  if (policy.routeOrder.length === 0 || policy.routeOrder.length > ROUTE_IDS.length) {
    throw new Error("Control-plane route order must contain one through three routes.");
  }
  const unique = new Set(policy.routeOrder);
  if (unique.size !== policy.routeOrder.length) {
    throw new Error("Control-plane route order may not contain duplicates.");
  }
  for (const route of policy.routeOrder) {
    if (!ROUTE_IDS.includes(route)) {
      throw new Error(`Unknown control-plane route: ${String(route)}`);
    }
  }
  validateBoundedPositiveInteger(
    policy.transportFailureThreshold,
    "Transport failure threshold",
    100,
  );
  validateBoundedPositiveInteger(policy.connectorRetryLimit, "Connector retry limit", 10);
  validateBoundedPositiveInteger(
    policy.sameRouteRetryDelayMs,
    "Same-route retry delay",
    2_147_483_647,
  );
  validateBoundedPositiveInteger(
    policy.routeSwitchDelayMs,
    "Route-switch delay",
    2_147_483_647,
  );
  validateBoundedPositiveInteger(policy.minimumDwellMs, "Minimum dwell", 2_147_483_647);
  validateBoundedPositiveInteger(policy.routeCooldownMs, "Route cooldown", 2_147_483_647);
  validateBoundedPositiveInteger(policy.switchWindowMs, "Switch window", 2_147_483_647);
  validateBoundedPositiveInteger(
    policy.maxSwitchesInWindow,
    "Maximum switches per window",
    1_000,
  );
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Control-plane failover event timestamp must be a non-negative safe integer.");
  }
}

function boundedReason(value: string): string {
  const normalized = value.replace(/[\r\n\0]+/gu, " ").trim();
  if (normalized.length === 0) {
    return "No diagnostic reason was supplied.";
  }
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 511)}…`;
}

function cloneRoutes(
  routes: Readonly<Record<ControlPlaneRouteId, ControlPlaneRouteRuntimeState>>,
): Record<ControlPlaneRouteId, ControlPlaneRouteRuntimeState> {
  return {
    primary: { ...routes.primary },
    backup: { ...routes.backup },
    direct: { ...routes.direct },
  };
}

function pruneSwitchHistory(
  history: readonly number[],
  at: number,
  windowMs: number,
): readonly number[] {
  const lowerBound = Math.max(0, at - windowMs);
  return history.filter((timestamp) => timestamp >= lowerBound && timestamp <= at);
}

function routeIsEligible(
  state: ControlPlaneFailoverState,
  route: ControlPlaneRouteId,
  at: number,
  policy: ControlPlaneFailoverPolicy,
): boolean {
  const runtime = state.routes[route];
  return runtime.status !== "disabled" &&
    runtime.consecutiveTransportFailures < policy.transportFailureThreshold &&
    runtime.consecutiveConnectorFailures <= policy.connectorRetryLimit &&
    (runtime.cooldownUntil === null || runtime.cooldownUntil <= at);
}

function nextRoute(
  state: ControlPlaneFailoverState,
  policy: ControlPlaneFailoverPolicy,
  at: number,
): ControlPlaneRouteId | null {
  const activeIndex = state.activeRoute === null
    ? -1
    : policy.routeOrder.indexOf(state.activeRoute);
  for (let offset = 1; offset <= policy.routeOrder.length; offset += 1) {
    const index = (Math.max(activeIndex, 0) + offset) % policy.routeOrder.length;
    const candidate = policy.routeOrder[index];
    if (
      candidate !== undefined &&
      candidate !== state.activeRoute &&
      routeIsEligible(state, candidate, at, policy)
    ) {
      return candidate;
    }
  }
  return null;
}

function switchTransition(
  failedState: ControlPlaneFailoverState,
  fromRoute: ControlPlaneRouteId,
  candidate: ControlPlaneRouteId,
  at: number,
  policy: ControlPlaneFailoverPolicy,
): ControlPlaneFailoverTransition {
  const switchedRoutes = cloneRoutes(failedState.routes);
  switchedRoutes[fromRoute] = {
    ...switchedRoutes[fromRoute],
    status: "cooling-down",
    cooldownUntil: at + policy.routeCooldownMs,
  };
  switchedRoutes[candidate] = {
    ...switchedRoutes[candidate],
    status: "probing",
  };
  const generation = failedState.attemptGeneration + 1;
  return {
    state: {
      ...failedState,
      lifecycle: "running",
      activeRoute: candidate,
      activeSince: null,
      attemptGeneration: generation,
      routes: switchedRoutes,
      switchHistory: [...failedState.switchHistory, at],
    },
    effect: {
      kind: "launch",
      route: candidate,
      generation,
      delayMs: policy.routeSwitchDelayMs,
      cause: "failover",
    },
  };
}

function launchTransition(
  state: ControlPlaneFailoverState,
  route: ControlPlaneRouteId,
  delayMs: number,
  cause: Extract<ControlPlaneFailoverEffect, { readonly kind: "launch" }>["cause"],
): ControlPlaneFailoverTransition {
  const routes = cloneRoutes(state.routes);
  routes[route] = { ...routes[route], status: "probing" };
  const generation = state.attemptGeneration + 1;
  return {
    state: {
      ...state,
      lifecycle: "running",
      activeRoute: route,
      attemptGeneration: generation,
      routes,
      circuitOpenedAt: null,
      circuitReason: null,
    },
    effect: { kind: "launch", route, generation, delayMs, cause },
  };
}

function circuitTransition(
  state: ControlPlaneFailoverState,
  at: number,
  reason: string,
): ControlPlaneFailoverTransition {
  const bounded = boundedReason(reason);
  return {
    state: {
      ...state,
      lifecycle: "circuit-open",
      activeSince: null,
      attemptGeneration: state.attemptGeneration + 1,
      circuitOpenedAt: at,
      circuitReason: bounded,
    },
    effect: { kind: "circuit-open", reason: bounded },
  };
}

export function createControlPlaneFailoverState(
  policy: ControlPlaneFailoverPolicy = DEFAULT_CONTROL_PLANE_FAILOVER_POLICY,
): ControlPlaneFailoverState {
  validatePolicy(policy);
  const enabled = new Set(policy.routeOrder);
  return {
    schemaVersion: "scr.control-plane-failover/v1",
    lifecycle: "stopped",
    activeRoute: null,
    activeSince: null,
    attemptGeneration: 0,
    routes: {
      primary: emptyRoute(enabled.has("primary")),
      backup: emptyRoute(enabled.has("backup")),
      direct: emptyRoute(enabled.has("direct")),
    },
    switchHistory: [],
    circuitOpenedAt: null,
    circuitReason: null,
  };
}

export function reduceControlPlaneFailover(
  state: ControlPlaneFailoverState,
  event: ControlPlaneFailoverEvent,
  policy: ControlPlaneFailoverPolicy = DEFAULT_CONTROL_PLANE_FAILOVER_POLICY,
): ControlPlaneFailoverTransition {
  validatePolicy(policy);
  validateTimestamp(event.at);

  if (event.type === "stop") {
    const enabled = new Set(policy.routeOrder);
    const routes: Record<ControlPlaneRouteId, ControlPlaneRouteRuntimeState> = {
      primary: emptyRoute(enabled.has("primary")),
      backup: emptyRoute(enabled.has("backup")),
      direct: emptyRoute(enabled.has("direct")),
    };
    const generation = state.attemptGeneration + 1;
    const reason = boundedReason(event.reason ?? "Operator stopped control-plane failover.");
    return {
      state: {
        ...state,
        lifecycle: "stopped",
        activeRoute: null,
        activeSince: null,
        attemptGeneration: generation,
        routes,
        switchHistory: [],
        circuitOpenedAt: null,
        circuitReason: null,
      },
      effect: { kind: "stop", generation, reason },
    };
  }

  if (event.type === "recover") {
    if (event.networkChanged === true && state.lifecycle === "running" &&
        state.activeRoute !== null && state.routes[state.activeRoute].status === "ready") {
      return launchTransition(state, state.activeRoute, 0, "same-route-retry");
    }
    if (state.lifecycle === "needs-attention") {
      const attentionRoute = state.activeRoute;
      if (attentionRoute === null) {
        return { state, effect: { kind: "ignored", reason: "No failed route to recover." } };
      }
      const attentionClass = state.routes[attentionRoute].lastFailureClass;
      if (attentionClass === "auth" || attentionClass === "identity") {
        return { state, effect: { kind: "ignored", reason: "Authorization and identity failures require local action." } };
      }
      const failedAt = state.routes[attentionRoute].lastFailureAt;
      const delay = event.networkChanged === true ? policy.routeSwitchDelayMs : policy.routeCooldownMs;
      if (failedAt !== null && event.at < failedAt + delay) {
        return { state, effect: { kind: "ignored", reason: "Attention recovery is waiting for cooldown." } };
      }
      const attentionHistory = pruneSwitchHistory(state.switchHistory, event.at, policy.switchWindowMs);
      if (attentionHistory.length >= policy.maxSwitchesInWindow) {
        return { state, effect: { kind: "ignored", reason: "Attention recovery is waiting for switch budget." } };
      }
      const attentionFirst = policy.routeOrder[0];
      if (attentionFirst === undefined) {
        return { state, effect: { kind: "ignored", reason: "No enabled route." } };
      }
      return launchTransition({
        ...createControlPlaneFailoverState(policy),
        attemptGeneration: state.attemptGeneration,
        switchHistory: attentionFirst === attentionRoute ? attentionHistory : [...attentionHistory, event.at],
      }, attentionFirst, 0, attentionFirst === attentionRoute ? "same-route-retry" : "failover");
    }

    if (state.lifecycle !== "circuit-open" || state.circuitOpenedAt === null ||
        state.activeRoute === null || state.routes[state.activeRoute].lastFailureClass !== "transport") {
      return { state, effect: { kind: "ignored", reason: "Only a transport circuit can recover automatically." } };
    }
    const history = pruneSwitchHistory(state.switchHistory, event.at, policy.switchWindowMs);
    const delay = event.networkChanged === true ? policy.routeSwitchDelayMs : policy.routeCooldownMs;
    if (event.at < state.circuitOpenedAt + delay || history.length >= policy.maxSwitchesInWindow) {
      return { state, effect: { kind: "ignored", reason: "Transport recovery is waiting for cooldown or switch budget." } };
    }
    const reset = createControlPlaneFailoverState(policy);
    const first = policy.routeOrder[0];
    if (first === undefined) return { state, effect: { kind: "ignored", reason: "No enabled route." } };
    const switching = first !== state.activeRoute;
    return launchTransition({
      ...reset,
      attemptGeneration: state.attemptGeneration,
      switchHistory: switching ? [...history, event.at] : history,
    }, first, 0, switching ? "failover" : "same-route-retry");
  }

  if (event.type === "manual-reset") {
    const reset = createControlPlaneFailoverState(policy);
    const invalidated: ControlPlaneFailoverState = {
      ...reset,
      attemptGeneration: state.attemptGeneration,
    };
    const first = policy.routeOrder[0];
    if (first === undefined) {
      return circuitTransition(invalidated, event.at, "No control-plane route is enabled.");
    }
    const transition = launchTransition(invalidated, first, 0, "manual-reset");
    return {
      ...transition,
      state: {
        ...transition.state,
        switchHistory: [],
      },
    };
  }

  if (event.type === "start") {
    if (state.lifecycle === "circuit-open") {
      return { state, effect: { kind: "ignored", reason: "Circuit requires an explicit manual reset." } };
    }
    if (state.lifecycle === "running" && state.activeRoute !== null) {
      return { state, effect: { kind: "ignored", reason: "A control-plane attempt is already active." } };
    }
    const first = policy.routeOrder.find((route) =>
      routeIsEligible(state, route, event.at, policy)
    );
    if (first === undefined) {
      return circuitTransition(state, event.at, "No eligible control-plane route is available.");
    }
    return launchTransition(state, first, 0, "start");
  }

  if (
    event.generation !== state.attemptGeneration ||
    event.route !== state.activeRoute ||
    state.lifecycle !== "running"
  ) {
    return {
      state,
      effect: { kind: "ignored", reason: "The event belongs to a stale or inactive attempt generation." },
    };
  }

  if (event.type === "attempt-ready") {
    const routes = cloneRoutes(state.routes);
    routes[event.route] = {
      ...routes[event.route],
      status: "ready",
      consecutiveConnectorFailures: 0,
      lastFailureClass: null,
      lastReadyAt: event.at,
      cooldownUntil: null,
    };
    return {
      state: {
        ...state,
        activeSince: event.at,
        routes,
      },
      effect: { kind: "hold", reason: `${event.route} control-plane route is ready.` },
    };
  }

  const reason = boundedReason(event.redactedReason);
  const routes = cloneRoutes(state.routes);
  const readyRoute = routes[event.route];
  if (readyRoute.status === "ready" && readyRoute.lastReadyAt !== null &&
      event.at - readyRoute.lastReadyAt >= policy.minimumDwellMs) {
    for (const route of ROUTE_IDS) {
      routes[route] = { ...routes[route], consecutiveTransportFailures: 0, consecutiveConnectorFailures: 0 };
    }
  }
  const current = routes[event.route];
  const updated: ControlPlaneRouteRuntimeState = {
    ...current,
    status: "failed",
    lastFailureClass: event.failureClass,
    lastFailureAt: event.at,
    consecutiveTransportFailures:
      event.failureClass === "transport"
        ? current.consecutiveTransportFailures + 1
        : current.consecutiveTransportFailures,
    consecutiveConnectorFailures:
      event.failureClass === "connector"
        ? current.consecutiveConnectorFailures + 1
        : current.consecutiveConnectorFailures,
  };
  routes[event.route] = updated;
  const failedState: ControlPlaneFailoverState = {
    ...state,
    routes,
    switchHistory: pruneSwitchHistory(state.switchHistory, event.at, policy.switchWindowMs),
  };

  if (event.failureClass === "connector") {
    if (updated.consecutiveConnectorFailures <= policy.connectorRetryLimit) {
      return launchTransition(
        failedState,
        event.route,
        policy.sameRouteRetryDelayMs,
        "same-route-retry",
      );
    }
    return {
      state: {
        ...failedState,
        lifecycle: "needs-attention",
        attemptGeneration: failedState.attemptGeneration + 1,
      },
      effect: { kind: "attention", failureClass: event.failureClass, reason },
    };
  }

  if (event.failureClass !== "transport") {
    // A route that never reached readiness has not been proven workable, and a
    // local observation cannot tell a broken route from a broken service. Try
    // the remaining configured routes before asking for local action so one
    // unusable proxy cannot take down an otherwise reachable direct route.
    if (
      event.failureClass !== "auth" &&
      event.failureClass !== "identity" &&
      event.failureClass !== "local-mcp" &&
      updated.lastReadyAt === null &&
      failedState.switchHistory.length < policy.maxSwitchesInWindow
    ) {
      const fallback = nextRoute(failedState, policy, event.at);
      if (fallback !== null) {
        return switchTransition(failedState, event.route, fallback, event.at, policy);
      }
    }
    return {
      state: {
        ...failedState,
        lifecycle: "needs-attention",
        attemptGeneration: failedState.attemptGeneration + 1,
      },
      effect: { kind: "attention", failureClass: event.failureClass, reason },
    };
  }

  if (updated.consecutiveTransportFailures < policy.transportFailureThreshold) {
    return launchTransition(
      failedState,
      event.route,
      policy.sameRouteRetryDelayMs,
      "same-route-retry",
    );
  }

  const dwellElapsed = state.activeSince === null
    ? Number.POSITIVE_INFINITY
    : event.at - state.activeSince;
  if (event.hardTransport !== true && dwellElapsed < policy.minimumDwellMs) {
    return launchTransition(
      failedState,
      event.route,
      policy.sameRouteRetryDelayMs,
      "same-route-retry",
    );
  }

  if (failedState.switchHistory.length >= policy.maxSwitchesInWindow) {
    return circuitTransition(
      failedState,
      event.at,
      `Control-plane route switch budget exhausted: ${reason}`,
    );
  }

  const candidate = nextRoute(failedState, policy, event.at);
  if (candidate === null) {
    return circuitTransition(
      failedState,
      event.at,
      `No alternate control-plane route is eligible: ${reason}`,
    );
  }

  return switchTransition(failedState, event.route, candidate, event.at, policy);
}

export function controlPlaneAttemptHealthFileName(generation: number): string {
  validateBoundedPositiveInteger(generation, "Attempt generation", 2_147_483_647);
  return `attempt-${generation}-health-url.txt`;
}

export function sanitizeTunnelChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || PROXY_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      continue;
    }
    result[key] = value;
  }
  result.NO_PROXY = "127.0.0.1,localhost,::1";
  return result;
}

export function redactControlPlaneDiagnostic(
  source: string,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = source;
  const candidates = [...new Set(sensitiveValues.filter((value) => value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    redacted = redacted.replaceAll(candidate, "[REDACTED]");
  }
  redacted = redacted.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    "$1[REDACTED]@",
  );
  redacted = redacted.replace(
    /\b(Authorization|Proxy-Authorization)\s*:\s*[^\r\n]+/giu,
    "$1: [REDACTED]",
  );
  redacted = redacted.replace(
    /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
    "Bearer [REDACTED]",
  );
  redacted = redacted.replace(
    /\b(CONTROL_PLANE_API_KEY|SCR_GATEWAY_AUTH_HEADER|SCR_TUNNEL_CONTROL_PLANE_PROXY_URL)\s*=\s*[^\s,;]+/giu,
    "$1=[REDACTED]",
  );
  redacted = redacted.replace(
    /"(CONTROL_PLANE_API_KEY|SCR_GATEWAY_AUTH_HEADER|SCR_TUNNEL_CONTROL_PLANE_PROXY_URL)"\s*:\s*"[^"]*"/giu,
    '"$1":"[REDACTED]"',
  );
  return redacted;
}
