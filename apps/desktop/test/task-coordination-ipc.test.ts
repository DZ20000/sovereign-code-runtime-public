import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared.js";
import { registerTaskIpc } from "../src/task-ipc.js";
import {
  COORDINATION_TEST_TIMESTAMPS,
  coordinationMessage,
  coordinationPage,
} from "./task-coordination-test-fixture.js";

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle } }));

type Controller = Parameters<typeof registerTaskIpc>[0];
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
const event = {} as IpcMainInvokeEvent;

function setup() {
  handle.mockClear();
  const controller = {
    taskWorkspaceSnapshot: vi.fn<Controller["taskWorkspaceSnapshot"]>(),
    taskDetail: vi.fn<Controller["taskDetail"]>(),
    taskCoordinationInbox: vi.fn<Controller["taskCoordinationInbox"]>()
      .mockResolvedValue(coordinationPage()),
    addTaskUserMessage: vi.fn<Controller["addTaskUserMessage"]>(),
  };
  const trusted = vi.fn<(event: IpcMainInvokeEvent) => void>();
  registerTaskIpc(controller, trusted);
  const handlers = new Map(handle.mock.calls as [string, Handler][]);
  const inbox = handlers.get(IPC_CHANNELS.getTaskCoordinationInbox);
  if (inbox === undefined) throw new Error("Coordination IPC was not registered.");
  return { controller, trusted, handlers, inbox };
}

describe("read-only coordination Electron IPC", () => {
  it("forwards a bounded conversation cursor and rejects invalid cursors before delegation", async () => {
    const value = setup();
    const detail = value.handlers.get(IPC_CHANNELS.getTaskDetail)!;
    await detail(event, "task-1", 100, 201);
    expect(value.controller.taskDetail).toHaveBeenCalledWith("task-1", 100, 201);
    for (const cursor of [0, -1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      await expect(detail(event, "task-1", 100, cursor)).rejects.toThrow();
    }
    expect(value.controller.taskDetail).toHaveBeenCalledTimes(1);
  });
  it("retains separate Task handlers and forwards only the bounded operator read", async () => {
    const value = setup();
    expect([...value.handlers.keys()]).toEqual([
      IPC_CHANNELS.getTaskWorkspace,
      IPC_CHANNELS.getTaskDetail,
      IPC_CHANNELS.getTaskCoordinationInbox,
      IPC_CHANNELS.sendTaskUserMessage,
    ]);
    await expect(value.inbox(event, "recipient-task")).resolves.toEqual(coordinationPage());
    expect(value.trusted).toHaveBeenCalledWith(event);
    expect(value.controller.taskCoordinationInbox).toHaveBeenCalledWith("recipient-task", undefined, 50);
    await value.inbox(event, "recipient-task", 23, 10);
    expect(value.controller.taskCoordinationInbox).toHaveBeenLastCalledWith("recipient-task", 23, 10);
    expect(value.controller.taskDetail).not.toHaveBeenCalled();
    expect(value.controller.addTaskUserMessage).not.toHaveBeenCalled();
  });

  it("preserves a complete historical delivery envelope without reinterpretation", async () => {
    const value = setup();
    const acknowledged = coordinationMessage("recipient-task", "acknowledged");
    const historical = coordinationPage("recipient-task", {
      ...acknowledged,
      expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
      expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
      recipient: {
        ...acknowledged.recipient,
        taskStatus: "succeeded",
        ownershipCurrent: false,
        principalCurrent: false,
      },
    });
    value.controller.taskCoordinationInbox.mockResolvedValueOnce(historical);

    await expect(value.inbox(event, "recipient-task")).resolves.toEqual(
      historical,
    );
    expect(value.controller.taskCoordinationInbox).toHaveBeenCalledOnce();
    expect(value.controller.taskDetail).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender before invoking any controller operation", async () => {
    const value = setup();
    value.trusted.mockImplementation(() => { throw new Error("Untrusted renderer"); });
    await expect(value.inbox(event, "recipient-task")).rejects.toThrow("Untrusted renderer");
    expect(value.controller.taskCoordinationInbox).not.toHaveBeenCalled();
    expect(value.controller.addTaskUserMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["", undefined, 50],
    ["x".repeat(129), undefined, 50],
    [null, undefined, 50],
    ["recipient-task", 0, 50],
    ["recipient-task", -1, 50],
    ["recipient-task", 0.5, 50],
    ["recipient-task", "2", 50],
    ["recipient-task", Number.MAX_SAFE_INTEGER + 1, 50],
    ["recipient-task", undefined, 0],
    ["recipient-task", undefined, 101],
    ["recipient-task", undefined, 1.5],
    ["recipient-task", undefined, "50"],
  ])("rejects malformed task/cursor/limit without delegation (%s, %s, %s)", async (id, before, limit) => {
    const value = setup();
    await expect(value.inbox(event, id, before, limit)).rejects.toThrow();
    expect(value.trusted).toHaveBeenCalledOnce();
    expect(value.controller.taskCoordinationInbox).not.toHaveBeenCalled();
  });

  it("propagates inbox failure instead of falling back to the Task conversation", async () => {
    const value = setup();
    value.controller.taskCoordinationInbox.mockRejectedValueOnce(new Error("Read unavailable"));
    await expect(value.inbox(event, "recipient-task")).rejects.toThrow("Read unavailable");
    expect(value.controller.taskDetail).not.toHaveBeenCalled();
    expect(value.controller.addTaskUserMessage).not.toHaveBeenCalled();
  });
});
