import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskCoordinationOperatorInbox } from "../src/shared.js";
import { TaskCoordinationInboxController } from "../src/renderer/task-coordination-controller.js";
import {
  TASK_COORDINATION_LOAD_TIMEOUT_MS,
  renderTaskCoordinationInbox,
  validateTaskCoordinationInbox,
} from "../src/renderer/task-coordination-inbox.js";
import { coordinationPage, inboxElements } from "./task-coordination-test-fixture.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function page(
  taskId: string,
  first: number,
  last: number,
  nextBeforeSequence: number | null,
  total = 125,
  generatedAt = "2026-08-30T00:01:00.000Z",
): TaskCoordinationOperatorInbox {
  const base = coordinationPage(taskId);
  const template = base.messages[0]!;
  const messages = Array.from(
    { length: last - first + 1 },
    (_, offset) => {
      const sequence = first + offset;
      return {
        ...template,
        id: `message-${taskId}-${sequence}`,
        ordinal: sequence,
        recipientSequence: sequence,
        senderSequence: sequence,
        content: `Message ${taskId} ${sequence}`,
        createdAt: new Date(
          Date.parse("2026-08-30T00:00:00.000Z") + sequence * 10,
        ).toISOString(),
      };
    },
  );
  return {
    ...base,
    generatedAt,
    messages,
    unreadCount: total,
    pendingCount: total,
    firstSequence: messages[0]?.recipientSequence ?? null,
    lastSequence: messages.at(-1)?.recipientSequence ?? null,
    nextBeforeSequence,
    truncated: nextBeforeSequence !== null,
  };
}

function sequences(container: ReturnType<typeof inboxElements>["container"]): number[] {
  return container.children.flatMap((child) => {
    const value = child.dataset.recipientSequence;
    return value === undefined ? [] : [Number(value)];
  });
}

function setup(
  read: (
    taskId: string,
    beforeSequence?: number,
    limit?: number,
  ) => Promise<TaskCoordinationOperatorInbox>,
  timestampLabel: (value: string) => string = (value) => value,
) {
  const dom = inboxElements();
  const api = { getTaskCoordinationInbox: vi.fn(read) };
  const controller = new TaskCoordinationInboxController(
    api,
    dom.elements,
    timestampLabel,
    dom.refreshButton,
  );
  return { ...dom, api, controller };
}
afterEach(() => vi.useRealTimers());

describe("independent Renderer coordination reads", () => {
  it("does not apply an old Task response after a quick switch", async () => {
    const a = deferred<TaskCoordinationOperatorInbox>();
    const b = deferred<TaskCoordinationOperatorInbox>();
    const v = setup(id => id === "a" ? a.promise : b.promise);
    v.controller.select("a");
    expect(v.pendingCount.textContent).toBe("Coordination count unavailable");
    const old = v.controller.refresh("a");
    v.controller.select("b");
    const current = v.controller.refresh("b");
    b.resolve(coordinationPage("b"));
    await current;
    a.resolve(coordinationPage("a"));
    await old;
    expect(v.container.dataset.taskId).toBe("b");
    expect(v.container.textContent).toContain("Message for b");
    expect(v.container.textContent).not.toContain("Message for a");
    expect(v.button.disabled).toBe(false);
  });

  it("coalesces polling while a read is pending and ignores completion after navigation away", async () => {
    const pending = deferred<TaskCoordinationOperatorInbox>();
    const v = setup(() => pending.promise);
    v.controller.select("a");
    const first = v.controller.refresh("a");
    expect(v.controller.refresh("a")).toBe(first);
    expect(v.api.getTaskCoordinationInbox).toHaveBeenCalledTimes(1);
    v.controller.clear();
    pending.resolve(coordinationPage("a"));
    await first;
    expect(v.container.dataset.taskId).toBeUndefined();
    expect(v.container.textContent).not.toContain("Message for a");
    expect(v.button.disabled).toBe(true);
  });

  it("keeps a failed read isolated and retries without consuming Agent receipts", async () => {
    const v = setup(async () => { throw new Error("Unavailable"); });
    v.controller.select("a");
    v.controller.updatePendingCount("a", 2);
    await v.controller.refresh("a");
    expect(v.container.textContent).toContain("Could not load coordination messages.");
    expect(v.pendingCount.textContent).toBe("2 coordination pending");
    expect(v.snapshotStatus.textContent).toBe("Coordination status unavailable.");
    expect(v.container.className).not.toContain("is-stale");
    expect(v.button.disabled).toBe(false);
    v.api.getTaskCoordinationInbox.mockResolvedValueOnce(coordinationPage("a"));
    v.button.click();
    await v.controller.refresh("a");
    expect(v.container.textContent).toContain("Message for a");
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated 2026-08-30T00:01:00.000Z.",
    );
    expect(v.api.getTaskCoordinationInbox).toHaveBeenLastCalledWith("a", undefined, 50);
  });

  it("isolates a causally malformed response without rendering or adopting it", async () => {
    const v = setup(async (id) => coordinationPage(id));
    v.controller.select("a");
    await v.controller.refresh("a");
    expect(v.container.textContent).toContain("Message for a");

    v.api.getTaskCoordinationInbox.mockResolvedValueOnce(
      coordinationPage("a", {
        content: "must not render",
        deliveryState: "acknowledged",
        acknowledgedAt: null,
      }),
    );
    await v.controller.refresh("a");

    expect(v.container.textContent).toContain("Message for a");
    expect(v.container.textContent).not.toContain("must not render");
    expect(v.container.dataset.freshness).toBe("stale");
    expect(v.pendingCount.textContent).toBe(
      "Last known: 1 coordination pending",
    );
    expect(v.unreadCount.textContent).toBe(
      "Last known: 1 coordination unread",
    );
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts may be out of date. Last updated 2026-08-30T00:01:00.000Z.",
    );
    expect(v.button.disabled).toBe(false);
  });

  it("bounds a stalled read and allows another attempt without accepting its late response", async () => {
    vi.useFakeTimers();
    const stalled = deferred<TaskCoordinationOperatorInbox>();
    const v = setup(() => stalled.promise);
    v.controller.select("a");
    const first = v.controller.refresh("a");
    await vi.advanceTimersByTimeAsync(TASK_COORDINATION_LOAD_TIMEOUT_MS);
    await first;
    expect(v.container.textContent).toContain("Could not load coordination messages.");
    v.api.getTaskCoordinationInbox.mockResolvedValueOnce(coordinationPage("a", { content: "new response" }));
    await v.controller.refresh("a");
    stalled.resolve(coordinationPage("a", { content: "stale response" }));
    await Promise.resolve();
    expect(v.container.textContent).toContain("new response");
    expect(v.container.textContent).not.toContain("stale response");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks the last successful snapshot stale after a later timeout", async () => {
    vi.useFakeTimers();
    const stalled = deferred<TaskCoordinationOperatorInbox>();
    const v = setup(
      async (taskId) => coordinationPage(taskId),
      (value) => "local(" + value + ")",
    );
    v.controller.select("a");
    await v.controller.refresh("a");
    const message = v.container.children[0];
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated local(2026-08-30T00:01:00.000Z).",
    );

    v.api.getTaskCoordinationInbox.mockImplementationOnce(() => stalled.promise);
    const refresh = v.controller.refresh("a");
    await vi.advanceTimersByTimeAsync(TASK_COORDINATION_LOAD_TIMEOUT_MS);
    await refresh;

    expect(v.container.children[0]).toBe(message);
    expect(v.pendingCount.textContent).toBe(
      "Last known: 1 coordination pending",
    );
    expect(v.unreadCount.textContent).toBe(
      "Last known: 1 coordination unread",
    );
    expect(v.pendingCount.dataset.freshness).toBe("stale");
    expect(v.unreadCount.dataset.freshness).toBe("stale");
    expect(v.container.dataset.freshness).toBe("stale");
    expect(v.container.className).toContain("is-stale");
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts may be out of date. Last updated local(2026-08-30T00:01:00.000Z).",
    );
    expect(v.loadOlderStatus.textContent).toBe("");

    v.controller.updatePendingCount("a", 9);
    expect(v.pendingCount.textContent).toBe(
      "Last known: 1 coordination pending",
    );
    stalled.resolve(coordinationPage("a", { content: "late timeout result" }));
    await Promise.resolve();
    expect(v.container.textContent).not.toContain("late timeout result");
    expect(v.container.dataset.freshness).toBe("stale");
  });

  it("marks malformed latest data stale and clears it on recovery", async () => {
    const v = setup(
      async (taskId) => coordinationPage(taskId),
      (value) => "shown(" + value + ")",
    );
    v.controller.select("a");
    await v.controller.refresh("a");
    const message = v.container.children[0];

    v.api.getTaskCoordinationInbox.mockResolvedValueOnce({
      ...coordinationPage("a"),
      unreadCount: 2,
      pendingCount: 1,
    });
    await v.controller.refresh("a");
    expect(v.container.children[0]).toBe(message);
    expect(v.container.dataset.freshness).toBe("stale");
    expect(v.snapshotStatus.textContent).toContain(
      "Last updated shown(2026-08-30T00:01:00.000Z).",
    );

    v.api.getTaskCoordinationInbox.mockResolvedValueOnce({
      ...coordinationPage("a", { content: "recovered snapshot" }),
      generatedAt: "2026-08-30T00:03:00.000Z",
      unreadCount: 0,
      pendingCount: 1,
    });
    await v.controller.refresh("a");
    expect(v.container.textContent).toContain("recovered snapshot");
    expect(v.pendingCount.textContent).toBe("1 coordination pending");
    expect(v.unreadCount.textContent).toBe("No unread coordination");
    expect(v.pendingCount.dataset.freshness).toBe("fresh");
    expect(v.unreadCount.dataset.freshness).toBe("fresh");
    expect(v.container.dataset.freshness).toBe("fresh");
    expect(v.container.className).not.toContain("is-stale");
    expect(v.snapshotStatus.className).not.toContain("is-stale");
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated shown(2026-08-30T00:03:00.000Z).",
    );
    expect(v.loadOlderStatus.textContent).toBe("");
  });

  it("does not carry stale state across a Task switch", async () => {
    const v = setup(async (taskId) => coordinationPage(taskId));
    v.controller.select("a");
    await v.controller.refresh("a");
    v.api.getTaskCoordinationInbox.mockRejectedValueOnce(new Error("Offline"));
    await v.controller.refresh("a");
    expect(v.container.dataset.freshness).toBe("stale");

    v.controller.select("b");
    expect(v.snapshotStatus.textContent).toBe("Loading coordination…");
    expect(v.container.dataset.freshness).toBe("loading");
    expect(v.container.className).not.toContain("is-stale");
    expect(v.pendingCount.textContent).toBe("Coordination count unavailable");
    expect(v.unreadCount.textContent).toBe(
      "Coordination unread count unavailable",
    );
    expect(v.loadOlderStatus.textContent).toBe("");

    v.api.getTaskCoordinationInbox.mockResolvedValueOnce({
      ...coordinationPage("b"),
      generatedAt: "2026-08-30T00:04:00.000Z",
    });
    await v.controller.refresh("b");
    expect(v.container.dataset.taskId).toBe("b");
    expect(v.container.dataset.freshness).toBe("fresh");
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated 2026-08-30T00:04:00.000Z.",
    );
  });

  it("preserves rows and reading position for an unchanged refreshed snapshot", async () => {
    const v = setup(async id => coordinationPage(id));
    v.controller.select("a");
    await v.controller.refresh("a");
    const original = v.container.children[0];
    v.container.scrollTop = 130;
    v.api.getTaskCoordinationInbox.mockResolvedValueOnce({ ...coordinationPage("a"), generatedAt: "2026-08-30T00:02:00.000Z" });
    await v.controller.refresh("a");
    expect(v.container.children[0]).toBe(original);
    expect(v.container.scrollTop).toBe(130);
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated 2026-08-30T00:02:00.000Z.",
    );
  });

  it("renders message text literally and does not assign old-principal work to the current Agent", () => {
    const v = inboxElements();
    const page = coordinationPage("a", { content: "<img src=x onerror=alert(1)>", recipient: { ...coordinationPage("a").messages[0]!.recipient, principalCurrent: false, ownershipCurrent: false }, deliveryState: "recipient-changed" });
    renderTaskCoordinationInbox(v.elements, page, value => value);
    expect(v.container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(v.container.textContent).toContain("Recipient changed");
    expect(v.container.textContent).not.toContain("Needs Agent acknowledgement");
    expect(v.container.children[0]?.attributes.get("role")).toBe("listitem");
    expect(v.container.children[0]?.children[1]?.attributes.has("data-no-i18n")).toBe(true);
  });

  it("does not let late Task detail counters overwrite the coordination snapshot", async () => {
    const v = setup(async id => coordinationPage(id));
    v.controller.select("a");
    v.controller.updatePendingCount("a", 4);
    await v.controller.refresh("a");
    v.controller.updatePendingCount("a", 9);
    v.controller.rerender();
    expect(v.pendingCount.textContent).toBe("1 coordination pending");
    expect(v.unreadCount.textContent).toBe("1 coordination unread");

    v.api.getTaskCoordinationInbox.mockResolvedValueOnce({
      ...coordinationPage("a", {
        readAt: "2026-08-30T00:00:30.000Z",
        deliveryState: "read",
      }),
      unreadCount: 0,
    });
    await v.controller.refresh("a");
    expect(v.pendingCount.textContent).toBe("1 coordination pending");
    expect(v.unreadCount.textContent).toBe("No unread coordination");
    expect(v.container.textContent).toContain("Needs Agent acknowledgement");
  });

  it("ignores an older snapshot of the same Task without reverting its counters", async () => {
    const v = setup(async id => coordinationPage(id));
    v.controller.select("a");
    await v.controller.refresh("a");
    v.api.getTaskCoordinationInbox.mockResolvedValueOnce({
      ...coordinationPage("a", { content: "older snapshot" }),
      generatedAt: "2026-08-30T00:00:30.000Z",
      unreadCount: 3,
      pendingCount: 3,
    });
    await v.controller.refresh("a");
    expect(v.container.textContent).toContain("Message for a");
    expect(v.container.textContent).not.toContain("older snapshot");
    expect(v.pendingCount.textContent).toBe("1 coordination pending");
    expect(v.unreadCount.textContent).toBe("1 coordination unread");
    expect(v.container.dataset.freshness).toBe("fresh");
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated 2026-08-30T00:01:00.000Z.",
    );
    expect(v.button.disabled).toBe(false);
    expect(v.container.attributes.get("aria-busy")).toBe("false");
  });

  it("rejects the first A response after navigating A to B and back to A", async () => {
    const firstA = deferred<TaskCoordinationOperatorInbox>();
    const v = setup(() => firstA.promise);
    v.controller.select("a");
    const old = v.controller.refresh("a");
    v.controller.select("b");
    v.controller.select("a");
    v.api.getTaskCoordinationInbox.mockResolvedValueOnce(
      coordinationPage("a", { content: "current A response" }),
    );
    await v.controller.refresh("a");
    firstA.resolve(coordinationPage("a", { content: "previous A response" }));
    await old;
    expect(v.container.textContent).toContain("current A response");
    expect(v.container.textContent).not.toContain("previous A response");
  });

  it("distinguishes loading, empty history and unavailable unread counts", async () => {
    const pending = deferred<TaskCoordinationOperatorInbox>();
    const v = setup(() => pending.promise);
    v.controller.select("a");
    const request = v.controller.refresh("a");
    expect(v.container.textContent).toContain("Loading coordination");
    expect(v.unreadCount.textContent).toBe("Coordination unread count unavailable");
    pending.resolve({
      ...coordinationPage("a"),
      messages: [],
      unreadCount: 0,
      pendingCount: 0,
      firstSequence: null,
      lastSequence: null,
    });
    await request;
    expect(v.container.textContent).toBe("No coordination messages.");
    expect(v.pendingCount.textContent).toBe("No coordination pending");
    expect(v.unreadCount.textContent).toBe("No unread coordination");
    v.api.getTaskCoordinationInbox.mockRejectedValueOnce(new Error("Disconnected"));
    await v.controller.refresh("a");
    expect(v.container.textContent).toBe("No coordination messages.");
    expect(v.loadOlderStatus.textContent).toBe("");
    expect(v.pendingCount.textContent).toBe(
      "Last known: No coordination pending",
    );
    expect(v.unreadCount.textContent).toBe(
      "Last known: No unread coordination",
    );
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts may be out of date. Last updated 2026-08-30T00:01:00.000Z.",
    );
    expect(v.container.className).toContain("is-stale");
  });

  it("shows the history operation only while an older cursor exists", () => {
    const v = inboxElements();
    const truncated = {
      ...coordinationPage("a", { recipientSequence: 2 }),
      firstSequence: 2,
      lastSequence: 2,
      nextBeforeSequence: 2,
      truncated: true,
      unreadCount: 7,
      pendingCount: 12,
    };
    renderTaskCoordinationInbox(v.elements, truncated, (value) => value);
    expect(v.loadOlderButton.hidden).toBe(false);
    expect(v.loadOlderButton.disabled).toBe(false);
    expect(v.container.textContent).not.toContain(
      "Older coordination messages are not shown.",
    );
    expect(v.pendingCount.textContent).toBe("12 coordination pending");
    expect(v.unreadCount.textContent).toBe("7 coordination unread");

    renderTaskCoordinationInbox(
      v.elements,
      coordinationPage("a"),
      (value) => value,
    );
    expect(v.loadOlderButton.hidden).toBe(true);
  });

  it("loads 125 messages across three pages without moving the visible anchor", async () => {
    const v = setup(async (taskId, beforeSequence) => {
      if (beforeSequence === undefined) return page(taskId, 76, 125, 76);
      if (beforeSequence === 76) return page(taskId, 26, 75, 26);
      if (beforeSequence === 26) return page(taskId, 1, 25, null);
      throw new Error(`Unexpected cursor ${String(beforeSequence)}`);
    });
    v.controller.select("a");
    await v.controller.refresh("a");
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 76),
    );
    expect(v.loadOlderButton.hidden).toBe(false);

    v.container.scrollTop = 240;
    const oldHeight = v.container.scrollHeight;
    v.loadOlderButton.click();
    const firstOlder = v.controller.loadOlder("a");
    expect(v.controller.loadOlder("a")).toBe(firstOlder);
    expect(v.loadOlderButton.disabled).toBe(true);
    expect(v.loadOlderStatus.textContent).toBe(
      "Loading earlier coordination…",
    );
    expect(v.api.getTaskCoordinationInbox).toHaveBeenCalledTimes(2);
    await firstOlder;
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 26),
    );
    expect(v.container.scrollTop).toBe(
      240 + v.container.scrollHeight - oldHeight,
    );
    expect(v.loadOlderButton.disabled).toBe(false);
    expect(v.loadOlderStatus.textContent).toBe(
      "Earlier coordination messages loaded.",
    );

    const secondOlder = v.controller.loadOlder("a");
    await secondOlder;
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 125 }, (_, index) => index + 1),
    );
    expect(v.loadOlderButton.hidden).toBe(true);
    expect(v.container.ownerDocument.activeElement).toBe(v.container);
    expect(v.api.getTaskCoordinationInbox.mock.calls).toEqual([
      ["a", undefined, 50],
      ["a", 76, 50],
      ["a", 26, 50],
    ]);
  });

  it("keeps loaded history while a new message arrives between pages and latest refreshes", async () => {
    let latestReads = 0;
    const v = setup(async (taskId, beforeSequence) => {
      if (beforeSequence === undefined) {
        latestReads += 1;
        return latestReads === 1
          ? page(taskId, 76, 125, 76, 125, "2026-08-30T00:01:00.000Z")
          : page(taskId, 77, 126, 77, 126, "2026-08-30T00:03:00.000Z");
      }
      if (beforeSequence === 76) {
        return page(taskId, 26, 75, 26, 126, "2026-08-30T00:02:00.000Z");
      }
      if (beforeSequence === 26) {
        return page(taskId, 1, 25, null, 126, "2026-08-30T00:04:00.000Z");
      }
      throw new Error(`Unexpected cursor ${String(beforeSequence)}`);
    });
    v.controller.select("a");
    await v.controller.refresh("a");
    await v.controller.loadOlder("a");
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 26),
    );
    expect(v.pendingCount.textContent).toBe("126 coordination pending");

    await v.controller.refresh("a");
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 101 }, (_, index) => index + 26),
    );
    expect(sequences(v.container).at(-1)).toBe(126);
    expect(v.pendingCount.textContent).toBe("126 coordination pending");

    await v.controller.loadOlder("a");
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 126 }, (_, index) => index + 1),
    );
    expect(v.loadOlderButton.hidden).toBe(true);
    expect(v.api.getTaskCoordinationInbox).toHaveBeenLastCalledWith(
      "a",
      26,
      50,
    );
  });

  it("retains loaded messages when an older page fails and recovers on retry", async () => {
    let olderAttempts = 0;
    const v = setup(async (taskId, beforeSequence) => {
      if (beforeSequence === undefined) return page(taskId, 76, 125, 76);
      olderAttempts += 1;
      if (olderAttempts === 1) throw new Error("History unavailable");
      return page(taskId, 26, 75, 26);
    });
    v.controller.select("a");
    await v.controller.refresh("a");
    const original = v.container.children[0];

    await v.controller.loadOlder("a");
    expect(v.container.children[0]).toBe(original);
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 76),
    );
    expect(v.loadOlderStatus.textContent).toBe(
      "Could not load earlier coordination messages. Loaded messages were retained.",
    );
    expect(v.loadOlderStatus.className).toContain("is-error");
    expect(v.loadOlderButton.hidden).toBe(false);
    expect(v.loadOlderButton.disabled).toBe(false);
    expect(v.snapshotStatus.textContent).toBe(
      "Coordination messages and counts updated 2026-08-30T00:01:00.000Z.",
    );
    expect(v.pendingCount.textContent).toBe("125 coordination pending");
    expect(v.container.dataset.freshness).toBe("fresh");
    expect(v.container.className).not.toContain("is-stale");

    await v.controller.loadOlder("a");
    expect(sequences(v.container)[0]).toBe(26);
    expect(v.loadOlderStatus.textContent).toBe(
      "Earlier coordination messages loaded.",
    );
  });

  it("rejects a repeated continuation cursor without duplicating rows", async () => {
    let validHistory = false;
    const v = setup(async (taskId, beforeSequence) => {
      if (beforeSequence === undefined) return page(taskId, 76, 125, 76);
      return validHistory
        ? page(taskId, 26, 75, 26)
        : page(taskId, 76, 125, 76);
    });
    v.controller.select("a");
    await v.controller.refresh("a");
    await v.controller.loadOlder("a");
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 76),
    );
    expect(v.loadOlderStatus.textContent).toContain(
      "Could not load earlier coordination messages",
    );

    validHistory = true;
    await v.controller.loadOlder("a");
    expect(new Set(sequences(v.container)).size).toBe(100);
    expect(sequences(v.container)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 26),
    );
  });

  it("discards an older-page response after a fast Task switch", async () => {
    const staleHistory = deferred<TaskCoordinationOperatorInbox>();
    const v = setup((taskId, beforeSequence) => {
      if (taskId === "a" && beforeSequence === undefined) {
        return Promise.resolve(page("a", 51, 100, 51, 100));
      }
      if (taskId === "a") return staleHistory.promise;
      return Promise.resolve(page("b", 1, 1, null, 1));
    });
    v.controller.select("a");
    await v.controller.refresh("a");
    const stale = v.controller.loadOlder("a");

    v.controller.select("b");
    await v.controller.refresh("b");
    staleHistory.resolve(page("a", 1, 50, null, 100));
    await stale;

    expect(v.container.dataset.taskId).toBe("b");
    expect(sequences(v.container)).toEqual([1]);
    expect(v.container.textContent).toContain("Message b 1");
    expect(v.container.textContent).not.toContain("Message a 50");
    expect(v.loadOlderButton.hidden).toBe(true);
  });

  it("discards an in-flight older page when a latest refresh supersedes it", async () => {
    const staleHistory = deferred<TaskCoordinationOperatorInbox>();
    let latestReads = 0;
    const v = setup((taskId, beforeSequence) => {
      if (beforeSequence !== undefined) return staleHistory.promise;
      latestReads += 1;
      return Promise.resolve(
        latestReads === 1
          ? page(taskId, 51, 100, 51, 100, "2026-08-30T00:01:00.000Z")
          : page(taskId, 52, 101, 52, 101, "2026-08-30T00:02:00.000Z"),
      );
    });
    v.controller.select("a");
    await v.controller.refresh("a");
    const stale = v.controller.loadOlder("a");
    await v.controller.refresh("a");
    staleHistory.resolve(page("a", 1, 50, null, 100));
    await stale;

    expect(sequences(v.container)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 51),
    );
    expect(v.container.textContent).not.toContain("Message a 50");
    expect(v.loadOlderButton.hidden).toBe(false);
    expect(v.loadOlderStatus.textContent).toBe("");
  });

  it("rejects a null creation timestamp instead of passing it to the time renderer", () => {
    const page = coordinationPage();
    const broken = { ...page, messages: [{ ...page.messages[0], createdAt: null }] } as unknown as TaskCoordinationOperatorInbox;
    expect(() => validateTaskCoordinationInbox(page.taskId, broken)).toThrow("creation timestamp");
  });
});
