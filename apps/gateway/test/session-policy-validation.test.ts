import { describe, expect, it } from "vitest";

import {
  PolicyEngine,
  RuntimeError,
  createPrincipal,
} from "@sovereign/runtime-core";
import { ToolCatalog } from "@sovereign/toolkit";

import { createGatewayApplication } from "../src/app.js";

function expectInvalidPolicy(
  overrides: Partial<{
    maxSessions: number;
    capacityReclaimIdleMs: number;
    sessionIdleTimeoutMs: number;
    sessionSweepIntervalMs: number;
  }>,
  message: string,
): void {
  const policy = new PolicyEngine();
  const catalog = new ToolCatalog([], policy, "0.1.0");
  try {
    createGatewayApplication({
      runtimeVersion: "0.1.0",
      catalog,
      bearerGrants: [
        {
          token: "test-token-0123456789abcdef",
          principal: createPrincipal("owner", [], []),
        },
      ],
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      maxSessions: 4,
      capacityReclaimIdleMs: 500,
      sessionIdleTimeoutMs: 1_000,
      sessionSweepIntervalMs: 500,
      ...overrides,
    });
    throw new Error("Expected the Gateway session policy to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("INTERNAL_ERROR");
    expect((error as Error).message).toContain(message);
  }
}

describe("direct Gateway session policy validation", () => {
  it("rejects a sweep interval that exceeds the idle timeout", () => {
    expectInvalidPolicy(
      { sessionSweepIntervalMs: 2_000 },
      "sessionSweepIntervalMs may not exceed",
    );
  });

  it("rejects duration values above the shared one-day ceiling", () => {
    expectInvalidPolicy(
      { sessionIdleTimeoutMs: 86_400_001 },
      "sessionIdleTimeoutMs must be an integer from 10 through 86400000",
    );
  });
});
