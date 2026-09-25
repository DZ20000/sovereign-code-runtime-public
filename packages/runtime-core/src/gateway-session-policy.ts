export interface GatewaySessionPolicy {
  readonly maxSessions: number;
  readonly capacityReclaimIdleMs: number;
  readonly sessionIdleTimeoutMs: number;
  readonly sessionSweepIntervalMs: number;
}

export const GATEWAY_SESSION_POLICY_ENVIRONMENT = Object.freeze({
  maxSessions: "SCR_GATEWAY_MAX_SESSIONS",
  capacityReclaimIdleMs: "SCR_GATEWAY_RECLAIM_IDLE_MS",
  sessionIdleTimeoutMs: "SCR_GATEWAY_SESSION_IDLE_MS",
  sessionSweepIntervalMs: "SCR_GATEWAY_SESSION_SWEEP_MS",
} as const);

const MIN_GATEWAY_SESSIONS = 1;
const MAX_GATEWAY_SESSIONS = 256;
const MIN_GATEWAY_SESSION_DURATION_MS = 10;
const MAX_GATEWAY_SESSION_DURATION_MS = 86_400_000;

type Environment = Readonly<Record<string, string | undefined>>;
type PolicyLabels = Readonly<Record<keyof GatewaySessionPolicy, string>>;

const PROPERTY_LABELS: PolicyLabels = Object.freeze({
  maxSessions: "gatewaySessionPolicy.maxSessions",
  capacityReclaimIdleMs: "gatewaySessionPolicy.capacityReclaimIdleMs",
  sessionIdleTimeoutMs: "gatewaySessionPolicy.sessionIdleTimeoutMs",
  sessionSweepIntervalMs: "gatewaySessionPolicy.sessionSweepIntervalMs",
});

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function validateGatewaySessionPolicyWithLabels(
  policy: GatewaySessionPolicy,
  labels: PolicyLabels,
): GatewaySessionPolicy {
  const maxSessions = boundedInteger(
    policy.maxSessions,
    labels.maxSessions,
    MIN_GATEWAY_SESSIONS,
    MAX_GATEWAY_SESSIONS,
  );
  const capacityReclaimIdleMs = boundedInteger(
    policy.capacityReclaimIdleMs,
    labels.capacityReclaimIdleMs,
    MIN_GATEWAY_SESSION_DURATION_MS,
    MAX_GATEWAY_SESSION_DURATION_MS,
  );
  const sessionIdleTimeoutMs = boundedInteger(
    policy.sessionIdleTimeoutMs,
    labels.sessionIdleTimeoutMs,
    MIN_GATEWAY_SESSION_DURATION_MS,
    MAX_GATEWAY_SESSION_DURATION_MS,
  );
  const sessionSweepIntervalMs = boundedInteger(
    policy.sessionSweepIntervalMs,
    labels.sessionSweepIntervalMs,
    MIN_GATEWAY_SESSION_DURATION_MS,
    MAX_GATEWAY_SESSION_DURATION_MS,
  );
  if (capacityReclaimIdleMs > sessionIdleTimeoutMs) {
    throw new Error(
      `${labels.capacityReclaimIdleMs} may not exceed ${labels.sessionIdleTimeoutMs}.`,
    );
  }
  if (sessionSweepIntervalMs > sessionIdleTimeoutMs) {
    throw new Error(
      `${labels.sessionSweepIntervalMs} may not exceed ${labels.sessionIdleTimeoutMs}.`,
    );
  }
  return Object.freeze({
    maxSessions,
    capacityReclaimIdleMs,
    sessionIdleTimeoutMs,
    sessionSweepIntervalMs,
  });
}

export function validateGatewaySessionPolicy(
  policy: GatewaySessionPolicy,
): GatewaySessionPolicy {
  return validateGatewaySessionPolicyWithLabels(policy, PROPERTY_LABELS);
}

export const DEFAULT_GATEWAY_SESSION_POLICY: GatewaySessionPolicy =
  validateGatewaySessionPolicy({
    maxSessions: 128,
    capacityReclaimIdleMs: 5 * 60 * 1_000,
    sessionIdleTimeoutMs: 30 * 60 * 1_000,
    sessionSweepIntervalMs: 60 * 1_000,
  });

function boundedIntegerEnvironment(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(
      `${name} must be a decimal integer from ${minimum} through ${maximum}.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be a decimal integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

export function gatewaySessionPolicyFromEnvironment(
  environment: Environment,
): GatewaySessionPolicy {
  return validateGatewaySessionPolicyWithLabels(
    {
      maxSessions: boundedIntegerEnvironment(
        environment,
        GATEWAY_SESSION_POLICY_ENVIRONMENT.maxSessions,
        DEFAULT_GATEWAY_SESSION_POLICY.maxSessions,
        MIN_GATEWAY_SESSIONS,
        MAX_GATEWAY_SESSIONS,
      ),
      capacityReclaimIdleMs: boundedIntegerEnvironment(
        environment,
        GATEWAY_SESSION_POLICY_ENVIRONMENT.capacityReclaimIdleMs,
        DEFAULT_GATEWAY_SESSION_POLICY.capacityReclaimIdleMs,
        MIN_GATEWAY_SESSION_DURATION_MS,
        MAX_GATEWAY_SESSION_DURATION_MS,
      ),
      sessionIdleTimeoutMs: boundedIntegerEnvironment(
        environment,
        GATEWAY_SESSION_POLICY_ENVIRONMENT.sessionIdleTimeoutMs,
        DEFAULT_GATEWAY_SESSION_POLICY.sessionIdleTimeoutMs,
        MIN_GATEWAY_SESSION_DURATION_MS,
        MAX_GATEWAY_SESSION_DURATION_MS,
      ),
      sessionSweepIntervalMs: boundedIntegerEnvironment(
        environment,
        GATEWAY_SESSION_POLICY_ENVIRONMENT.sessionSweepIntervalMs,
        DEFAULT_GATEWAY_SESSION_POLICY.sessionSweepIntervalMs,
        MIN_GATEWAY_SESSION_DURATION_MS,
        MAX_GATEWAY_SESSION_DURATION_MS,
      ),
    },
    GATEWAY_SESSION_POLICY_ENVIRONMENT,
  );
}
