import { beforeEach, describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) } }));
import { registerApprovalCenterIpc } from "../src/approval-center-ipc.js";
import { IPC_CHANNELS } from "../src/shared.js";

describe("main-window approval center IPC", () => {
  beforeEach(() => handlers.clear());

  it("exposes only list and focus, without a decision endpoint", async () => {
    const approvals = vi.fn(() => []);
    const openApproval = vi.fn(async () => "queued" as const);
    const trusted = vi.fn();
    registerApprovalCenterIpc({ approvals, openApproval }, trusted);
    expect([...handlers.keys()]).toEqual([IPC_CHANNELS.getApprovals, IPC_CHANNELS.openApproval]);
    await expect(handlers.get(IPC_CHANNELS.getApprovals)!({})).resolves.toEqual([]);
    await expect(handlers.get(IPC_CHANNELS.openApproval)!({}, "request-2")).resolves.toBe("queued");
    expect(trusted).toHaveBeenCalledTimes(2);
    expect(openApproval).toHaveBeenCalledWith("request-2");
    expect(handlers.has(IPC_CHANNELS.approvalResolve)).toBe(false);
  });

  it("rejects untrusted senders before reading or focusing any request", async () => {
    const approvals = vi.fn(() => []);
    const openApproval = vi.fn(async () => "opened" as const);
    registerApprovalCenterIpc({ approvals, openApproval }, () => { throw new Error("untrusted"); });
    await expect(handlers.get(IPC_CHANNELS.getApprovals)!({})).rejects.toThrow("untrusted");
    await expect(handlers.get(IPC_CHANNELS.openApproval)!({}, "request-1")).rejects.toThrow("untrusted");
    expect(approvals).not.toHaveBeenCalled();
    expect(openApproval).not.toHaveBeenCalled();
  });

  it("rejects missing and oversized request identifiers", async () => {
    const openApproval = vi.fn(async () => "opened" as const);
    registerApprovalCenterIpc({ approvals: () => [], openApproval }, () => {});
    for (const id of [null, "", "a".repeat(257)]) {
      await expect(handlers.get(IPC_CHANNELS.openApproval)!({}, id)).rejects.toThrow("invalid");
    }
    expect(openApproval).not.toHaveBeenCalled();
  });
});
