import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCoordinationOperatorInbox } from "@sovereign/control-plane-contract";
import {
  COORDINATION_TEST_TIMESTAMPS,
  coordinationMessage,
  coordinationPage,
} from "../../desktop/test/task-coordination-test-fixture.js";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  window: { label: "main" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.window }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const acknowledged = coordinationMessage("task-1", "acknowledged");
const page: TaskCoordinationOperatorInbox = coordinationPage("task-1", {
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

beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.window.label = "main";
});

describe("canonical coordination Tauri bridge", () => {
  it("preserves the optional ordinary conversation cursor", async () => {
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    await createTauriSovereignApi().getTaskDetail("task-1", 100, 301);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("control_call", {
      method: "tasks.get",
      params: { taskId: "task-1", messageLimit: 100, beforeSequence: 301 },
    });
  });
  it.each([
    ["main", "control_call"],
    ["renderer-preflight-test", "renderer_preflight_control_call"],
  ])("reads through the correct control boundary for %s", async (label, command) => {
    mocks.window.label = label;
    mocks.invoke.mockResolvedValueOnce(page);
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    const api = createTauriSovereignApi();
    await expect(api.getTaskCoordinationInbox("task-1")).resolves.toBe(page);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(command, {
      method: "tasks.coordination.operator-inbox",
      params: { taskId: "task-1", limit: 50 },
    });
  });

  it("preserves the backwards cursor and returns both counts unchanged", async () => {
    mocks.invoke.mockResolvedValueOnce(page);
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    await expect(createTauriSovereignApi().getTaskCoordinationInbox("task-1", 27, 12))
      .resolves.toEqual(page);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("control_call", {
      method: "tasks.coordination.operator-inbox",
      params: { taskId: "task-1", beforeSequence: 27, limit: 12 },
    });
  });

  it("does not substitute an Agent mailbox or Task-conversation call after failure", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Operator inbox unavailable"));
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    await expect(createTauriSovereignApi().getTaskCoordinationInbox("task-1"))
      .rejects.toThrow("Operator inbox unavailable");
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});
