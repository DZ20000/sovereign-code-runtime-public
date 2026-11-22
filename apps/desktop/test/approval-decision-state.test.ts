import { describe, expect, it, vi } from "vitest";
import { ApprovalDecisionState } from "../src/renderer/approval-decision-state.js";
import type { DesktopApprovalView } from "../src/shared.js";

const view = (overrides: Partial<DesktopApprovalView> = {}): DesktopApprovalView => ({
  id: "request-1", toolName: "terminal.exec", title: "Review", message: "Review", detail: "example",
  requestedAt: new Date(0).toISOString(), expiresAt: new Date(30_000).toISOString(), burstDetected: false,
  ...overrides,
});
function session(approval: DesktopApprovalView | null, resolve = vi.fn(async () => {})) {
  let now = 0;
  const state = new ApprovalDecisionState({ getCurrent: async () => approval, resolve }, () => {}, () => now);
  return { state, resolve, advance: (time: number) => { now = time; state.tick(); } };
}

describe("approval decision lifecycle", () => {
  it("submits one decision and keeps every later decision disabled", async () => {
    const { state, resolve } = session(view());
    await state.load();
    await state.decide("allow-once");
    await state.decide("allow-once");
    await state.decide("deny");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("request-1", "allow-once");
    expect(state.phase).toBe("submitting");
  });

  it("never retries or converts a missing acknowledgement into success", async () => {
    const resolve = vi.fn(async () => { throw new Error("lost acknowledgement"); });
    const { state, advance } = session(view(), resolve);
    await state.load();
    await state.decide("allow-once");
    expect(state.phase).toBe("uncertain");
    await state.decide("allow-once");
    await state.decide("deny");
    advance(60_000);
    expect(state.phase).toBe("uncertain");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired request before invoking the transport", async () => {
    const { state, resolve, advance } = session(view());
    await state.load();
    advance(30_000);
    await state.decide("allow-once");
    await state.decide("deny");
    expect(state.phase).toBe("expired");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("requires a real burst flag for drop-to-L1", async () => {
    const normal = session(view());
    await normal.state.load();
    await normal.state.decide("drop-to-l1");
    expect(normal.resolve).not.toHaveBeenCalled();
    const burst = session(view({ burstDetected: true }));
    await burst.state.load();
    await burst.state.decide("drop-to-l1");
    expect(burst.resolve).toHaveBeenCalledWith("request-1", "drop-to-l1");
  });

  it("an explicit administrator handoff cannot authorize execution", async () => {
    const { state, resolve } = session(view({ context: {
      requesterId: "principal-example", workspaceId: "example-project",
      permissionLevel: "consequential", destructive: false, sideEffect: "process",
      target: { kind: "command", value: "example command" }, administratorRequired: true,
    } }));
    await state.load();
    await state.decide("allow-once");
    expect(resolve).not.toHaveBeenCalled();
    await state.decide("deny");
    expect(resolve).toHaveBeenCalledWith("request-1", "deny");
  });

  it("fails closed for unavailable, invalid deadline and load failures", async () => {
    for (const approval of [null, view({ expiresAt: "invalid" })]) {
      const { state, resolve } = session(approval);
      await state.load();
      await state.decide("allow-once");
      expect(resolve).not.toHaveBeenCalled();
      expect(["unavailable", "expired"]).toContain(state.phase);
    }
    const resolve = vi.fn();
    const state = new ApprovalDecisionState({ getCurrent: async () => { throw new Error("offline"); }, resolve }, () => {});
    await state.load();
    await state.decide("allow-once");
    expect(state.phase).toBe("unavailable");
    expect(resolve).not.toHaveBeenCalled();
  });
});
