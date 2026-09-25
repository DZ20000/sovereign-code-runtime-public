import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_PLANE_FAILOVER_POLICY,
  controlPlaneAttemptHealthFileName,
  createControlPlaneFailoverState,
  redactControlPlaneDiagnostic,
  reduceControlPlaneFailover,
  sanitizeTunnelChildEnvironment,
  type ControlPlaneFailoverPolicy,
  type ControlPlaneFailoverState,
} from "../src/control-plane-failover.js";

const POLICY: ControlPlaneFailoverPolicy = {
  ...DEFAULT_CONTROL_PLANE_FAILOVER_POLICY,
  routeOrder: ["primary", "backup"],
  transportFailureThreshold: 2,
  connectorRetryLimit: 1,
  sameRouteRetryDelayMs: 10,
  routeSwitchDelayMs: 20,
  minimumDwellMs: 100,
  routeCooldownMs: 1_000,
  switchWindowMs: 10_000,
  maxSwitchesInWindow: 4,
};

function start(policy: ControlPlaneFailoverPolicy = POLICY) {
  return reduceControlPlaneFailover(
    createControlPlaneFailoverState(policy),
    { type: "start", at: 0 },
    policy,
  );
}

function ready(state: ControlPlaneFailoverState, at: number, policy = POLICY) {
  if (state.activeRoute === null) throw new Error("No active route.");
  return reduceControlPlaneFailover(state, {
    type: "attempt-ready",
    at,
    route: state.activeRoute,
    generation: state.attemptGeneration,
  }, policy);
}

function fail(
  state: ControlPlaneFailoverState,
  at: number,
  failureClass: "transport" | "auth" | "identity" | "local-mcp" | "connector" | "unknown",
  policy = POLICY,
  hardTransport = false,
) {
  if (state.activeRoute === null) throw new Error("No active route.");
  return reduceControlPlaneFailover(state, {
    type: "attempt-failed",
    at,
    route: state.activeRoute,
    generation: state.attemptGeneration,
    failureClass,
    redactedReason: `${failureClass} test failure`,
    hardTransport,
  }, policy);
}

describe("control-plane failover policy", () => {
  it("starts on the first enabled route and leaves direct disabled", () => {
    const transition = start();
    expect(transition.effect).toEqual({
      kind: "launch",
      route: "primary",
      generation: 1,
      delayMs: 0,
      cause: "start",
    });
    expect(transition.state.routes.primary.status).toBe("probing");
    expect(transition.state.routes.backup.status).toBe("untested");
    expect(transition.state.routes.direct.status).toBe("disabled");
  });

  it("ignores events from stale generations or inactive routes", () => {
    const started = start();
    const staleReady = reduceControlPlaneFailover(started.state, {
      type: "attempt-ready",
      at: 10,
      route: "primary",
      generation: 999,
    }, POLICY);
    const staleFailure = reduceControlPlaneFailover(started.state, {
      type: "attempt-failed",
      at: 11,
      route: "backup",
      generation: started.state.attemptGeneration,
      failureClass: "transport",
      redactedReason: "late event",
    }, POLICY);
    expect(staleReady.effect.kind).toBe("ignored");
    expect(staleFailure.effect.kind).toBe("ignored");
  });

  it("retries the same route after the first transport failure", () => {
    const active = ready(start().state, 10).state;
    const failed = fail(active, 200, "transport");
    expect(failed.effect).toEqual({
      kind: "launch",
      route: "primary",
      generation: 2,
      delayMs: 10,
      cause: "same-route-retry",
    });
    expect(failed.state.routes.primary.consecutiveTransportFailures).toBe(1);
  });

  it("switches only after the threshold and dwell are satisfied", () => {
    const active = ready(start().state, 10).state;
    const first = fail(active, 200, "transport").state;
    const second = fail(first, 210, "transport");
    expect(second.effect).toEqual({
      kind: "launch",
      route: "backup",
      generation: 3,
      delayMs: 20,
      cause: "failover",
    });
    expect(second.state.routes.primary.status).toBe("cooling-down");
    expect(second.state.routes.backup.status).toBe("probing");
    expect(second.state.switchHistory).toEqual([210]);
  });

  it("does not erase repeated transport failures when local readiness briefly returns", () => {
    const first = fail(ready(start().state, 10).state, 20, "transport", POLICY, true).state;
    const brieflyReady = ready(first, 30).state;
    expect(brieflyReady.routes.primary.consecutiveTransportFailures).toBe(1);
    expect(fail(brieflyReady, 40, "transport", POLICY, true).effect)
      .toMatchObject({ kind: "launch", route: "backup", cause: "failover" });
    const stable = fail(brieflyReady, 130, "transport", POLICY, true);
    expect(stable.effect).toMatchObject({ kind: "launch", route: "primary", cause: "same-route-retry" });
    expect(stable.state.routes.primary.consecutiveTransportFailures).toBe(1);
  });

  it("keeps soft transport failure on the current route during dwell", () => {
    const active = ready(start().state, 100).state;
    const first = fail(active, 110, "transport").state;
    const second = fail(first, 120, "transport");
    expect(second.effect).toMatchObject({
      kind: "launch",
      route: "primary",
      cause: "same-route-retry",
    });
  });

  it("allows confirmed hard transport to bypass dwell after threshold", () => {
    const active = ready(start().state, 100).state;
    const first = fail(active, 110, "transport").state;
    const second = fail(first, 120, "transport", POLICY, true);
    expect(second.effect).toMatchObject({
      kind: "launch",
      route: "backup",
      cause: "failover",
    });
  });

  for (const failureClass of ["auth", "identity", "local-mcp", "unknown"] as const) {
    it(`${failureClass} failure requires attention and never switches`, () => {
      const active = ready(start().state, 10).state;
      const failed = fail(active, 200, failureClass);
      expect(failed.effect).toMatchObject({ kind: "attention", failureClass });
      expect(failed.state.lifecycle).toBe("needs-attention");
      expect(failed.state.activeRoute).toBe("primary");
      expect(failed.state.switchHistory).toEqual([]);
    });
  }

  it("retries one connector failure, then requires attention", () => {
    const active = ready(start().state, 10).state;
    const first = fail(active, 20, "connector");
    const second = fail(first.state, 30, "connector");
    expect(first.effect).toMatchObject({ kind: "launch", route: "primary" });
    expect(second.effect).toMatchObject({ kind: "attention", failureClass: "connector" });
  });

  it("Stop invalidates the generation and blocks late relaunch", () => {
    const active = ready(start().state, 10).state;
    const stopped = reduceControlPlaneFailover(active, {
      type: "stop",
      at: 20,
      reason: "workspace change",
    }, POLICY);
    const late = reduceControlPlaneFailover(stopped.state, {
      type: "attempt-failed",
      at: 21,
      route: "primary",
      generation: active.attemptGeneration,
      failureClass: "transport",
      redactedReason: "late callback",
    }, POLICY);
    expect(stopped.effect).toMatchObject({ kind: "stop", reason: "workspace change" });
    expect(stopped.state.attemptGeneration).toBe(active.attemptGeneration + 1);
    expect(late.effect.kind).toBe("ignored");
  });

  it("skips an alternate route that is cooling down", () => {
    const policy: ControlPlaneFailoverPolicy = {
      ...POLICY,
      routeOrder: ["primary", "backup", "direct"],
    };
    const active = ready(start(policy).state, 10, policy).state;
    const prepared: ControlPlaneFailoverState = {
      ...active,
      routes: {
        ...active.routes,
        backup: {
          ...active.routes.backup,
          status: "cooling-down",
          cooldownUntil: 10_000,
        },
      },
    };
    const first = fail(prepared, 200, "transport", policy).state;
    const second = fail(first, 210, "transport", policy, true);
    expect(second.effect).toMatchObject({ kind: "launch", route: "direct" });
  });

  it("opens the circuit after every configured route is exhausted in one incident", () => {
    const active = ready(start().state, 10).state;
    const primaryRetry = fail(active, 200, "transport").state;
    const backupLaunch = fail(primaryRetry, 210, "transport", POLICY, true).state;
    const backupRetry = fail(backupLaunch, 220, "transport").state;
    const exhausted = fail(backupRetry, 230, "transport", POLICY, true);

    expect(exhausted.effect.kind).toBe("circuit-open");
    expect(exhausted.state.lifecycle).toBe("circuit-open");
    expect(exhausted.state.switchHistory).toEqual([210]);
  });

  it("opens the circuit when no alternate route exists", () => {
    const policy: ControlPlaneFailoverPolicy = { ...POLICY, routeOrder: ["primary"] };
    const active = ready(start(policy).state, 10, policy).state;
    const first = fail(active, 200, "transport", policy).state;
    const second = fail(first, 210, "transport", policy, true);
    expect(second.effect.kind).toBe("circuit-open");
    expect(second.state.lifecycle).toBe("circuit-open");
  });

  it("opens the circuit after the switch budget is exhausted", () => {
    const active = ready(start().state, 10).state;
    const prepared: ControlPlaneFailoverState = {
      ...active,
      switchHistory: [100, 110, 120, 130],
    };
    const first = fail(prepared, 200, "transport").state;
    const second = fail(first, 210, "transport", POLICY, true);
    expect(second.effect.kind).toBe("circuit-open");
    expect(second.state.circuitReason).toContain("switch budget exhausted");
  });

  it("manual reset clears the circuit and starts a fresh generation", () => {
    const policy: ControlPlaneFailoverPolicy = { ...POLICY, routeOrder: ["primary"] };
    const active = ready(start(policy).state, 10, policy).state;
    const first = fail(active, 200, "transport", policy).state;
    const circuit = fail(first, 210, "transport", policy, true).state;
    const reset = reduceControlPlaneFailover(circuit, { type: "manual-reset", at: 300 }, policy);
    expect(reset.effect).toMatchObject({ kind: "launch", route: "primary", cause: "manual-reset" });
    expect(reset.state.circuitOpenedAt).toBeNull();
    expect(reset.state.attemptGeneration).toBe(circuit.attemptGeneration + 1);
  });

  it("recovers a transport circuit after cooldown without clearing its switch budget", () => {
    const first = fail(start().state, 200, "transport").state;
    const backup = fail(first, 210, "transport", POLICY, true).state;
    const retried = fail(backup, 220, "transport").state;
    const circuit = fail(retried, 230, "transport", POLICY, true).state;
    const early = reduceControlPlaneFailover(circuit, { type: "recover", at: 300 }, POLICY);
    expect(early.effect.kind).toBe("ignored");
    const recovered = reduceControlPlaneFailover(circuit, { type: "recover", at: 1230 }, POLICY);
    expect(recovered.effect).toMatchObject({ kind: "launch", route: "primary", cause: "failover" });
    expect(recovered.state.attemptGeneration).toBe(circuit.attemptGeneration + 1);
    expect(recovered.state.routes.primary.consecutiveTransportFailures).toBe(0);
    expect(recovered.state.switchHistory).toEqual([210, 1230]);
    const lastSwitch = reduceControlPlaneFailover({ ...circuit, switchHistory: [100, 110, 120] }, { type: "recover", at: 1230 }, POLICY);
    expect(lastSwitch.state.switchHistory).toEqual([100, 110, 120, 1230]);
    expect(reduceControlPlaneFailover({ ...circuit, switchHistory: lastSwitch.state.switchHistory }, { type: "recover", at: 2230 }, POLICY).effect.kind).toBe("ignored");
    const changed = reduceControlPlaneFailover(circuit, { type: "recover", at: 300, networkChanged: true }, POLICY);
    expect(changed.effect.kind).toBe("launch");
    const budget = { ...circuit, switchHistory: [100, 110, 120, 130] };
    expect(reduceControlPlaneFailover(budget, { type: "recover", at: 300, networkChanged: true }, POLICY).effect.kind).toBe("ignored");
    expect(reduceControlPlaneFailover(budget, { type: "recover", at: 10131 }, POLICY).effect.kind).toBe("launch");
    for (const inactive of [
      reduceControlPlaneFailover(circuit, { type: "stop", at: 300 }, POLICY).state,
      fail(start().state, 200, "auth").state,
    ]) {
      expect(reduceControlPlaneFailover(inactive, { type: "recover", at: 20000, networkChanged: true }, POLICY).effect.kind).toBe("ignored");
    }
  });

  it("rebuilds the ready route on network change without selecting a node or resetting history", () => {
    const active = { ...ready(start().state, 10).state, switchHistory: [1, 2] };
    const result = reduceControlPlaneFailover(active, { type: "recover", at: 300, networkChanged: true }, POLICY);
    expect(result.effect).toMatchObject({ kind: "launch", route: "primary", cause: "same-route-retry" });
    expect(result.state.switchHistory).toEqual([1, 2]);
    expect(result.state.attemptGeneration).toBe(active.attemptGeneration + 1);
  });

  it("rejects duplicate route configuration", () => {
    expect(() => createControlPlaneFailoverState({
      ...POLICY,
      routeOrder: ["primary", "primary"],
    })).toThrow(/duplicates/u);
  });

  it("rejects timer values beyond the safe scheduling range", () => {
    expect(() => createControlPlaneFailoverState({
      ...POLICY,
      sameRouteRetryDelayMs: 2_147_483_648,
    })).toThrow(/positive safe integer/u);
  });
});
describe("control-plane failover boundary helpers", () => {
  it("creates generation-bound health filenames", () => {
    expect(controlPlaneAttemptHealthFileName(7)).toBe("attempt-7-health-url.txt");
    expect(() => controlPlaneAttemptHealthFileName(0)).toThrow(/positive safe integer/u);
  });

  it("removes inherited route variables case-insensitively", () => {
    const sanitized = sanitizeTunnelChildEnvironment({
      Path: "C:\\Windows\\System32",
      HTTPS_PROXY: "route-a",
      http_proxy: "route-b",
      npm_config_https_proxy: "route-c",
      KEEP_ME: "yes",
    });
    expect(sanitized).toEqual({
      Path: "C:\\Windows\\System32",
      KEEP_ME: "yes",
      NO_PROXY: "127.0.0.1,localhost,::1",
    });
  });

  it("redacts bounded sensitive diagnostic values", () => {
    const output = redactControlPlaneDiagnostic(
      [
        "route=http://user:VALUE_GAMMA_1234@proxy.example:8080",
        "Authorization: Bearer TOKEN_ALPHA_1234",
        "CONTROL_PLANE_API_KEY=VALUE_ALPHA_1234",
      ].join("\n"),
      ["VALUE_ALPHA_1234", "VALUE_GAMMA_1234"],
    );
    expect(output).not.toContain("VALUE_ALPHA_1234");
    expect(output).not.toContain("VALUE_GAMMA_1234");
    expect(output).not.toContain("TOKEN_ALPHA_1234");
    expect(output).toContain("[REDACTED]");
  });

  it("recovers attention after cooldown or a network change unless local authorization is required", () => {
    const attention = fail(start().state, 200, "local-mcp").state;
    expect(attention.lifecycle).toBe("needs-attention");
    expect(
      reduceControlPlaneFailover(attention, { type: "recover", at: 250 }, POLICY).effect.kind,
    ).toBe("ignored");
    expect(
      reduceControlPlaneFailover(attention, { type: "recover", at: 210, networkChanged: true }, POLICY).effect.kind,
    ).toBe("ignored");
    const recovered = reduceControlPlaneFailover(
      attention,
      { type: "recover", at: 20_000, networkChanged: true },
      POLICY,
    );
    expect(recovered.effect).toMatchObject({ kind: "launch", route: "primary" });
    expect(recovered.state.lifecycle).toBe("running");
    expect(reduceControlPlaneFailover(attention, { type: "recover", at: 1_200 }, POLICY).effect.kind).toBe("launch");
    for (const blocked of ["auth", "identity"] as const) {
      const stuck = fail(start().state, 200, blocked).state;
      expect(
        reduceControlPlaneFailover(stuck, { type: "recover", at: 20_000, networkChanged: true }, POLICY).effect.kind,
      ).toBe("ignored");
    }
  });

  it("tries the remaining routes before attention when a route never reached readiness", () => {
    const policy: ControlPlaneFailoverPolicy = {
      ...POLICY,
      routeOrder: ["primary", "direct"],
      switchWindowMs: 600_000,
    };
    const started = start(policy).state;
    const failed = reduceControlPlaneFailover(
      started,
      {
        type: "attempt-failed",
        at: 5_000,
        route: "primary",
        generation: started.attemptGeneration,
        failureClass: "unknown",
        redactedReason: "startup readiness timeout",
      },
      policy,
    );
    expect(failed.effect).toMatchObject({ kind: "launch", route: "direct", cause: "failover" });

    // Every configured route is tried, and the switch budget bounds the cycle.
    let state = failed.state;
    let at = 9_000;
    const attempted: string[] = [];
    let effect = failed.effect;
    for (let index = 0; index < 5 && effect.kind === "launch"; index += 1) {
      const route = state.activeRoute;
      if (route === null) throw new Error("No active route.");
      attempted.push(route);
      const transition = reduceControlPlaneFailover(
        state,
        {
          type: "attempt-failed",
          at,
          route,
          generation: state.attemptGeneration,
          failureClass: "unknown",
          redactedReason: "startup readiness timeout",
        },
        policy,
      );
      effect = transition.effect;
      state = transition.state;
      at += 4_000;
    }
    expect(attempted).toContain("direct");
    expect(attempted).toContain("primary");
    expect(effect.kind).toBe("attention");
    expect(state.switchHistory.length).toBe(POLICY.maxSwitchesInWindow);
  });

  it("keeps route-independent failures and proven routes out of the fallback path", () => {
    const policy: ControlPlaneFailoverPolicy = { ...POLICY, routeOrder: ["primary", "direct"] };
    for (const blocked of ["auth", "identity", "local-mcp"] as const) {
      const started = start(policy).state;
      expect(
        reduceControlPlaneFailover(
          started,
          {
            type: "attempt-failed",
            at: 5_000,
            route: "primary",
            generation: started.attemptGeneration,
            failureClass: blocked,
            redactedReason: blocked + " failure",
          },
          policy,
        ).effect,
      ).toMatchObject({ kind: "attention", failureClass: blocked });
    }
    const proven = ready(start(policy).state, 10, policy).state;
    expect(
      reduceControlPlaneFailover(
        proven,
        {
          type: "attempt-failed",
          at: 5_000,
          route: "primary",
          generation: proven.attemptGeneration,
          failureClass: "unknown",
          redactedReason: "unknown failure after a proven route",
        },
        policy,
      ).effect.kind,
    ).toBe("attention");
  });
});
