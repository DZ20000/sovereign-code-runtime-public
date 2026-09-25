import { describe, expect, it } from "vitest";

import {
  ApprovalBroker,
  type ApprovalDecision,
  type ApprovalPresentation,
} from "../src/approval-broker.js";

function request(toolName: string) {
  return {
    toolName,
    title: `${toolName} approval`,
    message: `Allow ${toolName}?`,
    detail: `Details for ${toolName}`,
  } as const;
}

describe("ApprovalBroker", () => {
  it("serializes approvals and records a bounded lifecycle", async () => {
    const presentations: ApprovalPresentation[] = [];
    const resolvers: Array<(decision: ApprovalDecision) => void> = [];
    const broker = new ApprovalBroker({
      surface: {
        present: async (presentation) => {
          presentations.push(presentation);
          return await new Promise<ApprovalDecision>((resolve) => resolvers.push(resolve));
        },
      },
      maxEvents: 8,
    });

    const first = broker.request(request("terminal.start"));
    const second = broker.request(request("python.start"));
    expect(presentations.map((item) => item.toolName)).toEqual(["terminal.start"]);
    expect(broker.pendingCount()).toBe(2);

    resolvers[0]?.("allow-once");
    await expect(first).resolves.toBe("allow-once");
    await Promise.resolve();
    expect(presentations.map((item) => item.toolName)).toEqual([
      "terminal.start",
      "python.start",
    ]);

    resolvers[1]?.("deny");
    await expect(second).resolves.toBe("deny");
    expect(broker.pendingCount()).toBe(0);
    expect(broker.events().at(-1)).toMatchObject({
      toolName: "python.start",
      kind: "resolved",
      decision: "deny",
    });
    expect(broker.events().length).toBeLessThanOrEqual(8);
  });

  it("fails closed when an approval expires", async () => {
    const broker = new ApprovalBroker({
      surface: {
        present: async (_presentation, signal) =>
          await new Promise<ApprovalDecision>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
      timeoutMs: 20,
    });

    await expect(broker.request(request("computer.action"))).resolves.toBe("deny");
    expect(broker.events().at(-1)).toMatchObject({
      kind: "cancelled",
      reason: "timeout",
    });
  });

  it("detects bursts, rejects queue overflow, and cancels pending work", async () => {
    const presentations: ApprovalPresentation[] = [];
    const resolvers: Array<(decision: ApprovalDecision) => void> = [];
    const broker = new ApprovalBroker({
      surface: {
        present: async (presentation) => {
          presentations.push(presentation);
          return await new Promise<ApprovalDecision>((resolve) => resolvers.push(resolve));
        },
      },
      maxQueue: 2,
      burstThreshold: 2,
      burstWindowMs: 1_000,
    });

    const first = broker.request(request("terminal.start"));
    const second = broker.request(request("python.start"));
    await expect(broker.request(request("computer.action"))).resolves.toBe("deny");
    expect(broker.events().some((event) => event.kind === "queue-overflow")).toBe(true);

    resolvers[0]?.("allow-once");
    await expect(first).resolves.toBe("allow-once");
    await Promise.resolve();
    expect(presentations[1]?.burstDetected).toBe(true);

    broker.cancelAll("runtime-stop");
    await expect(second).resolves.toBe("deny");
    expect(broker.events().at(-1)).toMatchObject({
      toolName: "python.start",
      kind: "cancelled",
      reason: "runtime-stop",
    });
  });
});
