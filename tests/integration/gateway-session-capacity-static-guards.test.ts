import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

function source(...segments: string[]): string {
  return readFileSync(resolve(root, ...segments), "utf8");
}

describe("Gateway session capacity configuration wiring", () => {
  it("uses one strictly validated environment policy for standalone and embedded runtimes", () => {
    const policy = source(
      "packages",
      "runtime-core",
      "src",
      "gateway-session-policy.ts",
    );
    const standalone = source("apps", "gateway", "src", "index.ts");
    const runtime = source("apps", "gateway", "src", "runtime.ts");

    for (const name of [
      "SCR_GATEWAY_MAX_SESSIONS",
      "SCR_GATEWAY_RECLAIM_IDLE_MS",
      "SCR_GATEWAY_SESSION_IDLE_MS",
      "SCR_GATEWAY_SESSION_SWEEP_MS",
    ]) {
      expect(policy).toContain(name);
    }
    expect(standalone).toContain("startGatewayRuntime");
    expect(runtime).toContain(
      "gatewaySessionPolicyFromEnvironment(process.env)",
    );
  });

  it("validates explicit overrides through the same shared policy", () => {
    const runtime = source("apps", "gateway", "src", "runtime.ts");
    const application = source("apps", "gateway", "src", "app.ts");

    expect(runtime).toContain("gatewaySessionPolicy?: GatewaySessionPolicy");
    expect(runtime).toContain(
      "validateGatewaySessionPolicy(options.gatewaySessionPolicy)",
    );
    expect(runtime).toContain("...gatewaySessionPolicy");
    expect(runtime).toContain("gatewaySessionPolicy,");
    expect(application).toContain("validateGatewaySessionPolicy({");
    expect(application).toContain("DEFAULT_GATEWAY_SESSION_POLICY");
    expect(application).not.toContain(
      "const maxSessions = config.maxSessions ?? 128",
    );
  });

  it("keeps the Runtime Host on the shared policy instead of a divergent parser", () => {
    const runtimeHost = source("apps", "runtime-host", "src", "main.ts");
    const controller = source(
      "packages",
      "control-plane",
      "src",
      "controller.ts",
    );
    const duplicateSource = resolve(
      root,
      "apps",
      "runtime-host",
      "src",
      "gateway-session-config.ts",
    );
    const duplicateTest = resolve(
      root,
      "apps",
      "runtime-host",
      "test",
      "gateway-session-config.test.ts",
    );

    expect(existsSync(duplicateSource)).toBe(false);
    expect(existsSync(duplicateTest)).toBe(false);
    expect(runtimeHost).toContain("new ControlPlaneController");
    expect(runtimeHost).not.toContain("gatewaySessionConfigFromEnvironment");
    expect(runtimeHost).not.toContain("SCR_GATEWAY_MAX_SESSIONS");
    expect(controller).toContain("startGatewayRuntime({");
  });

  it("keeps the configured ceiling bounded and preserves reclaim behavior", () => {
    const policy = source(
      "packages",
      "runtime-core",
      "src",
      "gateway-session-policy.ts",
    );
    const application = source("apps", "gateway", "src", "app.ts");

    expect(policy).toContain("256");
    expect(application).toContain("reclaimIdleSessionsForCapacity");
    expect(application).toContain("retryAfterSeconds");
    expect(application).toContain('response.setHeader("Retry-After"');
  });
});
