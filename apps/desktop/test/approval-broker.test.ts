import { describe, expect, it, vi } from "vitest";

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

describe("approval center safety", () => {
  it("lists isolated snapshots and focuses only the matching active request", async () => {
    const resolvers: Array<(decision: ApprovalDecision) => void> = [];
    const focus = vi.fn(() => true);
    const broker = new ApprovalBroker({ surface: {
      focus,
      present: async () => await new Promise<ApprovalDecision>((resolve) => resolvers.push(resolve)),
    } });
    const context = {
      requesterId: "principal-example", workspaceId: "example-project",
      permissionLevel: "consequential" as const, destructive: true, sideEffect: "write",
      target: { kind: "path" as const, value: "reports/summary.md" },
    };
    const first = broker.request({ ...request("files.delete"), context });
    const second = broker.request(request("terminal.exec"));
    const snapshot = broker.snapshot();
    expect(snapshot.map((entry) => entry.phase)).toEqual(["active", "queued"]);
    (snapshot[0]!.context!.target as { value: string }).value = "changed snapshot";
    expect(broker.snapshot()[0]!.context!.target.value).toBe("reports/summary.md");
    await expect(broker.open(snapshot[1]!.id)).resolves.toBe("queued");
    await expect(broker.open("stale-request")).resolves.toBe("unavailable");
    expect(focus).not.toHaveBeenCalled();
    await expect(broker.open(snapshot[0]!.id)).resolves.toBe("opened");
    expect(focus).toHaveBeenCalledWith(snapshot[0]!.id);
    expect(resolvers).toHaveLength(1);
    broker.cancelAll();
    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
  });

  it("does not present an already-expired queued request or accept a late allow", async () => {
    let now = 0;
    const resolvers: Array<(decision: ApprovalDecision) => void> = [];
    const present = vi.fn(async () => await new Promise<ApprovalDecision>((resolve) => resolvers.push(resolve)));
    const broker = new ApprovalBroker({ surface: { present }, timeoutMs: 10_000, now: () => now });
    const first = broker.request(request("terminal.exec"));
    const second = broker.request(request("files.delete"));
    now = 10_000;
    expect(broker.snapshot()).toEqual([]);
    resolvers[0]!("allow-once");
    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
    expect(present).toHaveBeenCalledTimes(1);
    expect(broker.events().at(-1)).toMatchObject({ kind: "cancelled", reason: "timeout" });
  });

  it("uses only the original remaining deadline after a queue wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const resolvers: Array<(decision: ApprovalDecision) => void> = [];
    const broker = new ApprovalBroker({
      timeoutMs: 1_000,
      surface: { present: async () => await new Promise<ApprovalDecision>((resolve) => resolvers.push(resolve)) },
    });
    try {
      const first = broker.request(request("terminal.exec"));
      await vi.advanceTimersByTimeAsync(50);
      const second = broker.request(request("files.delete"));
      await vi.advanceTimersByTimeAsync(750);
      resolvers[0]!("allow-once");
      await expect(first).resolves.toBe("allow-once");
      expect(broker.snapshot()[0]!.expiresAt).toBe(new Date(1_050).toISOString());
      await vi.advanceTimersByTimeAsync(250);
      await expect(second).resolves.toBe("deny");
      expect(broker.pendingCount()).toBe(0);
    } finally {
      broker.cancelAll();
      vi.useRealTimers();
    }
  });

  it("an administrator handoff remains a denial even if a surface returns allow", async () => {
    const broker = new ApprovalBroker({ surface: { present: async () => "allow-once" } });
    await expect(broker.request({ ...request("terminal.exec"), context: {
      requesterId: "principal-example", workspaceId: "example-project",
      permissionLevel: "consequential", destructive: false, sideEffect: "process",
      target: { kind: "command", value: "example command" }, administratorRequired: true,
    } })).resolves.toBe("deny");
  });
});
