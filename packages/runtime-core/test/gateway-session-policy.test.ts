import { describe, expect, it } from "vitest";

import {
  DEFAULT_GATEWAY_SESSION_POLICY,
  gatewaySessionPolicyFromEnvironment,
  validateGatewaySessionPolicy,
} from "../src/gateway-session-policy.js";

const explicitPolicy = {
  maxSessions: 32,
  capacityReclaimIdleMs: 60_000,
  sessionIdleTimeoutMs: 1_800_000,
  sessionSweepIntervalMs: 30_000,
} as const;

describe("Gateway session policy environment", () => {
  it("preserves the existing bounded defaults when no override is present", () => {
    expect(gatewaySessionPolicyFromEnvironment({})).toEqual(
      DEFAULT_GATEWAY_SESSION_POLICY,
    );
  });

  it("accepts the configured high-capacity local policy", () => {
    const policy = gatewaySessionPolicyFromEnvironment({
      SCR_GATEWAY_MAX_SESSIONS: "256",
      SCR_GATEWAY_RECLAIM_IDLE_MS: "60000",
      SCR_GATEWAY_SESSION_IDLE_MS: "1800000",
      SCR_GATEWAY_SESSION_SWEEP_MS: "30000",
    });
    expect(policy).toEqual({
      maxSessions: 256,
      capacityReclaimIdleMs: 60_000,
      sessionIdleTimeoutMs: 1_800_000,
      sessionSweepIntervalMs: 30_000,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([
    ["SCR_GATEWAY_MAX_SESSIONS", "257"],
    ["SCR_GATEWAY_MAX_SESSIONS", "1.5"],
    ["SCR_GATEWAY_RECLAIM_IDLE_MS", "9"],
    ["SCR_GATEWAY_SESSION_IDLE_MS", "-1"],
    ["SCR_GATEWAY_SESSION_SWEEP_MS", "1e3"],
  ])("rejects invalid %s values", (name, value) => {
    expect(() =>
      gatewaySessionPolicyFromEnvironment({ [name]: value }),
    ).toThrow(name);
  });

  it("rejects reclaim or sweep intervals that exceed the idle timeout", () => {
    expect(() =>
      gatewaySessionPolicyFromEnvironment({
        SCR_GATEWAY_RECLAIM_IDLE_MS: "2000",
        SCR_GATEWAY_SESSION_IDLE_MS: "1000",
      }),
    ).toThrow("may not exceed");
    expect(() =>
      gatewaySessionPolicyFromEnvironment({
        SCR_GATEWAY_SESSION_IDLE_MS: "1000",
        SCR_GATEWAY_SESSION_SWEEP_MS: "2000",
      }),
    ).toThrow("may not exceed");
  });
});

describe("explicit Gateway session policy validation", () => {
  it("returns a frozen copy for a valid explicit policy", () => {
    const validated = validateGatewaySessionPolicy(explicitPolicy);
    expect(validated).toEqual(explicitPolicy);
    expect(validated).not.toBe(explicitPolicy);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it.each([
    ["maxSessions", { ...explicitPolicy, maxSessions: 257 }],
    [
      "capacityReclaimIdleMs",
      { ...explicitPolicy, capacityReclaimIdleMs: 86_400_001 },
    ],
    ["sessionIdleTimeoutMs", { ...explicitPolicy, sessionIdleTimeoutMs: 10.5 }],
    [
      "sessionSweepIntervalMs",
      { ...explicitPolicy, sessionSweepIntervalMs: 86_400_001 },
    ],
  ])("rejects an invalid explicit %s", (name, policy) => {
    expect(() => validateGatewaySessionPolicy(policy)).toThrow(name);
  });

  it("applies the same cross-field ordering to explicit policies", () => {
    expect(() =>
      validateGatewaySessionPolicy({
        ...explicitPolicy,
        capacityReclaimIdleMs: 2_000,
        sessionIdleTimeoutMs: 1_000,
      }),
    ).toThrow("capacityReclaimIdleMs may not exceed");
    expect(() =>
      validateGatewaySessionPolicy({
        ...explicitPolicy,
        capacityReclaimIdleMs: 500,
        sessionIdleTimeoutMs: 1_000,
        sessionSweepIntervalMs: 2_000,
      }),
    ).toThrow("sessionSweepIntervalMs may not exceed");
  });
});
