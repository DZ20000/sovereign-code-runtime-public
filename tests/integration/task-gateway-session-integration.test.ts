import { describe, expect, it, vi } from "vitest";

import {
  createTaskGatewaySessionCallbacks,
  touchTaskSessionForToolActivity,
} from "../../packages/control-plane/src/task-gateway-integration.js";
import type { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";

describe("Task Gateway session integration", () => {
  it("renews and closes only the exact server-issued transport session", () => {
    const touchSessionActivity = vi.fn(() => ["task-a"]);
    const closeSession = vi.fn(() => ["task-a"]);
    const registry = {
      touchSessionActivity,
      closeSession,
    } as unknown as TaskRegistry;
    const callbacks = createTaskGatewaySessionCallbacks(registry);

    callbacks.onExternalSessionActivity?.({
      principalId: "chatgpt-web",
      sessionId: "transport-session-a",
      observedAt: "2026-08-30T05:00:00.000Z",
    });
    callbacks.onExternalSessionClosed?.({
      principalId: "chatgpt-web",
      sessionId: "transport-session-a",
      reason: "client-delete",
      observedAt: "2026-08-30T05:01:00.000Z",
    });

    expect(touchSessionActivity).toHaveBeenCalledOnce();
    expect(touchSessionActivity).toHaveBeenCalledWith(
      "chatgpt-web",
      "transport-session-a",
      "2026-08-30T05:00:00.000Z",
    );
    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledWith(
      "chatgpt-web",
      "transport-session-a",
      "client-delete",
      "2026-08-30T05:01:00.000Z",
    );
  });

  it("uses trusted tool activity timestamps and ignores events without a transport session", () => {
    const touchSessionActivity = vi.fn(() => []);
    const registry = { touchSessionActivity } as unknown as TaskRegistry;

    touchTaskSessionForToolActivity(registry, {
      phase: "started",
      principalId: "chatgpt-web",
      sessionId: "transport-session-start",
      startedAt: "2026-08-30T06:00:00.000Z",
    } as never);
    touchTaskSessionForToolActivity(registry, {
      phase: "completed",
      principalId: "chatgpt-web",
      sessionId: "transport-session-complete",
      startedAt: "2026-08-30T06:01:00.000Z",
      completedAt: "2026-08-30T06:01:05.000Z",
    } as never);
    touchTaskSessionForToolActivity(registry, {
      phase: "completed",
      principalId: "chatgpt-web",
      sessionId: null,
      startedAt: "2026-08-30T06:02:00.000Z",
      completedAt: "2026-08-30T06:02:05.000Z",
    } as never);

    expect(touchSessionActivity).toHaveBeenCalledTimes(2);
    expect(touchSessionActivity).toHaveBeenNthCalledWith(
      1,
      "chatgpt-web",
      "transport-session-start",
      "2026-08-30T06:00:00.000Z",
    );
    expect(touchSessionActivity).toHaveBeenNthCalledWith(
      2,
      "chatgpt-web",
      "transport-session-complete",
      "2026-08-30T06:01:05.000Z",
    );
  });
});
