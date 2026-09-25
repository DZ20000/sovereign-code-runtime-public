import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopTaskDetail, DesktopTaskMessage, DesktopTaskSummary, SovereignDesktopApi } from "../../apps/desktop/src/shared.js";
import { TaskMessageHistory } from "../../apps/desktop/src/renderer/task-message-history.js";
import { TasksController } from "../../apps/desktop/src/renderer/tasks-controller.js";
import { inboxElements } from "../../apps/desktop/test/task-coordination-test-fixture.js";
import { fixture } from "./task-registry-fixture.js";

vi.mock("../../apps/desktop/src/renderer/task-step-list.js", () => ({ reconcileTaskStepList: vi.fn() }));
vi.mock("../../apps/desktop/src/renderer/task-session-continuity-view.js", () => ({ renderTaskSessionContinuity: vi.fn() }));
vi.mock("../../apps/desktop/src/renderer/task-project-groups.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../apps/desktop/src/renderer/task-project-groups.js")>(),
  renderTaskProjectGroupManager: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

function history(read: SovereignDesktopApi["getTaskDetail"]) {
  const dom = inboxElements();
  const render = vi.fn<(messages: readonly DesktopTaskMessage[], task: DesktopTaskSummary, truncated: boolean) => void>();
  const getTaskDetail = vi.fn(read);
  const value = new TaskMessageHistory({ getTaskDetail }, {
    button: dom.loadOlderButton as unknown as HTMLButtonElement,
    status: dom.loadOlderStatus as unknown as HTMLElement,
    render,
  });
  return { value, getTaskDetail, render, button: dom.loadOlderButton, status: dom.loadOlderStatus };
}

describe("Task conversation history", () => {
  it("reads every retained message backwards while preserving history across latest refreshes", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "History" }, "chatgpt-web", workspace);
    for (let index = 1; index <= 180; index += 1) registry.addUserMessage(task.id, `Instruction ${index}`);
    const h = history(async (id, limit, before) => registry.detail(id, limit, before));
    h.value.update(registry.detail(task.id, 50));
    await h.value.loadOlder();
    expect(h.getTaskDetail).toHaveBeenLastCalledWith(task.id, 100, 132);
    expect(h.render.mock.lastCall?.[0]).toHaveLength(150);
    registry.addUserMessage(task.id, "New instruction during paging");
    h.value.update(registry.detail(task.id, 50));
    expect(h.render.mock.lastCall?.[0]).toHaveLength(151);
    await h.value.loadOlder();
    expect(h.getTaskDetail).toHaveBeenLastCalledWith(task.id, 100, 32);
    expect(h.render.mock.lastCall?.[0].map((message) => message.sequence)).toEqual(Array.from({ length: 182 }, (_, index) => index + 1));
    expect(h.button.hidden).toBe(true);
    expect(h.render.mock.lastCall?.[2]).toBe(false);
  });

  it("keeps the same byte budget on older pages and rejects malformed cursors", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "Large history" }, "chatgpt-web", workspace);
    for (let index = 0; index < 50; index += 1) registry.addUserMessage(task.id, "😀".repeat(3998));
    const first = registry.detail(task.id, 300);
    expect(first.messagesTruncated).toBe(true);
    const older = registry.detail(task.id, 100, first.oldestMessageSequence!);
    expect(older.messages.length).toBeGreaterThan(0);
    expect(older.newestMessageSequence!).toBeLessThan(first.oldestMessageSequence!);
    expect(Buffer.byteLength(JSON.stringify(older, null, 2), "utf8")).toBeLessThanOrEqual(640 * 1024);
    for (const cursor of [0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => registry.detail(task.id, 100, cursor)).toThrow();
    }
  });

  it("keeps loaded history while refreshing earlier acknowledgements from the server", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "Acknowledgement history", agentId: "agent-history" }, "chatgpt-web", workspace);
    for (let index = 1; index <= 180; index += 1) registry.addUserMessage(task.id, `Instruction ${index}`);
    const h = history(async (id, limit, before) => registry.detail(id, limit, before));
    h.value.update(registry.detail(task.id, 50));
    await h.value.loadOlder();
    await h.value.loadOlder();
    const loaded = h.render.mock.lastCall![0];
    const expectedIds = loaded.map((message) => message.id);
    registry.heartbeat({ taskId: task.id, agentId: "agent-history", acknowledgeThroughSequence: 181 }, "chatgpt-web");
    let resolve!: (detail: DesktopTaskDetail) => void;
    h.getTaskDetail.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));

    h.value.update(registry.detail(task.id, 50));
    expect(h.render.mock.lastCall![0].map((message) => message.id)).toEqual(expectedIds);
    expect(h.render.mock.lastCall![0].find((message) => message.role === "user")?.acknowledgedAt).toBeNull();
    expect(h.status.textContent).toContain("Syncing");
    expect(h.button.disabled).toBe(true);
    const syncing = h.value.loadOlder();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    registry.addUserMessage(task.id, "New instruction while acknowledgements sync");
    h.value.update(registry.detail(task.id, 50));
    resolve(registry.detail(task.id, 100, 132));
    await syncing;

    const refreshed = h.render.mock.lastCall![0];
    expect(refreshed.slice(0, loaded.length).map((message) => ({ id: message.id, content: message.content })))
      .toEqual(loaded.map((message) => ({ id: message.id, content: message.content })));
    expect(refreshed).toEqual(registry.detail(task.id).messages);
    expect(h.render.mock.lastCall![1].unreadUserMessageCount).toBe(1);
    expect(h.button.hidden).toBe(true);
    expect(h.status.textContent).toContain("synchronized");
  });

  it("preserves bodies after acknowledgement sync failures, rejects corrupt pages, and retries", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "Retry acknowledgements", agentId: "agent-history" }, "chatgpt-web", workspace);
    registry.addUserMessage(task.id, "Earlier instruction");
    registry.addUserMessage(task.id, "Latest instruction");
    const h = history(async (id, limit, before) => registry.detail(id, limit, before));
    h.value.update(registry.detail(task.id, 1));
    await h.value.loadOlder();
    const loaded = h.render.mock.lastCall![0];
    registry.heartbeat({ taskId: task.id, agentId: "agent-history", acknowledgeThroughSequence: 3 }, "chatgpt-web");
    h.getTaskDetail.mockRejectedValueOnce(new Error("offline"));
    h.value.update(registry.detail(task.id, 1));
    await h.value.loadOlder();
    expect(h.render.mock.lastCall![0]).toBe(loaded);
    expect(h.status.textContent).toContain("Could not sync");
    expect(h.button.hidden).toBe(false);
    expect(h.button.disabled).toBe(false);
    expect(h.button.textContent).toBe("Retry message sync");

    const validPage = registry.detail(task.id, 100, 3);
    h.getTaskDetail.mockResolvedValueOnce({ ...validPage, messages: validPage.messages.map((message) => ({ ...message, acknowledgedAt: null })) });
    await h.value.loadOlder();
    expect(h.render.mock.lastCall![0]).toBe(loaded);
    expect(h.status.textContent).toContain("Could not sync");
    await h.value.loadOlder();
    expect(h.render.mock.lastCall![0]).toEqual(registry.detail(task.id).messages);
    expect(h.button.hidden).toBe(true);
    expect(h.button.textContent).toBe("Load earlier messages");
  });

  it("invalidates an old page during acknowledgement sync and ignores sync results after switching tasks", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "In-flight acknowledgement", agentId: "agent-history" }, "chatgpt-web", workspace);
    const other = registry.createTask({ title: "Other history" }, "chatgpt-web", workspace);
    for (let index = 1; index <= 180; index += 1) registry.addUserMessage(task.id, `Instruction ${index}`);
    const h = history(async (id, limit, before) => registry.detail(id, limit, before));
    h.value.update(registry.detail(task.id, 50));
    await h.value.loadOlder();
    const loaded = h.render.mock.lastCall![0];
    const oldPage = registry.detail(task.id, 100, 32);
    let resolveOld!: (detail: DesktopTaskDetail) => void;
    let resolveSync!: (detail: DesktopTaskDetail) => void;
    h.getTaskDetail.mockImplementationOnce(() => new Promise((done) => { resolveOld = done; }));
    const loading = h.value.loadOlder();
    registry.heartbeat({ taskId: task.id, agentId: "agent-history", acknowledgeThroughSequence: 181 }, "chatgpt-web");
    h.getTaskDetail.mockImplementationOnce(() => new Promise((done) => { resolveSync = done; }));
    h.value.update(registry.detail(task.id, 50));
    const syncing = h.value.loadOlder();
    await vi.waitFor(() => expect(resolveSync).toBeTypeOf("function"));
    resolveOld(oldPage);
    await loading;
    expect(h.render.mock.lastCall![0]).toBe(loaded);
    expect(h.button.disabled).toBe(true);
    expect(h.status.textContent).toContain("Syncing");

    h.value.select(other.id);
    h.value.update(registry.detail(other.id));
    resolveSync(registry.detail(task.id, 100, 132));
    await syncing;
    expect(h.render.mock.lastCall![1].id).toBe(other.id);
    expect(h.render.mock.lastCall![0]).toEqual(registry.detail(other.id).messages);
    expect(h.status.textContent).toBe("");
    expect(h.button.hidden).toBe(true);
    expect(h.button.textContent).toBe("Load earlier messages");
  });

  it("retains messages after read failure or an old Runtime ignoring the cursor, then retries", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "Retry history" }, "chatgpt-web", workspace);
    for (let index = 0; index < 5; index += 1) registry.addUserMessage(task.id, `Message ${index}`);
    const latest = registry.detail(task.id, 2);
    const h = history(async (id, limit, before) => registry.detail(id, limit, before));
    h.value.update(latest);
    h.getTaskDetail.mockRejectedValueOnce(new Error("offline"));
    await h.value.loadOlder();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.status.textContent).toContain("Loaded messages were retained");
    h.getTaskDetail.mockResolvedValueOnce(latest);
    await h.value.loadOlder();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.button.hidden).toBe(false);
    h.getTaskDetail.mockResolvedValueOnce({ ...latest, messages: [], oldestMessageSequence: null, newestMessageSequence: null });
    await h.value.loadOlder();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.button.hidden).toBe(false);
    expect(h.status.textContent).toContain("Could not load earlier messages");
    await h.value.loadOlder();
    expect(h.render.mock.lastCall?.[0]).toHaveLength(6);
    expect(h.button.hidden).toBe(true);
  });

  it("ignores an older response after switching tasks and coalesces repeated clicks", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask({ title: "First" }, "chatgpt-web", workspace);
    const other = registry.createTask({ title: "Second" }, "chatgpt-web", workspace);
    registry.addUserMessage(task.id, "earlier");
    registry.addUserMessage(task.id, "latest");
    let resolve!: (detail: DesktopTaskDetail) => void;
    const h = history(() => new Promise((done) => { resolve = done; }));
    h.value.update(registry.detail(task.id, 1));
    const pending = h.value.loadOlder();
    expect(h.value.loadOlder()).toBe(pending);
    h.value.select(other.id);
    h.value.update(registry.detail(other.id));
    resolve(registry.detail(task.id, 100, 2));
    await pending;
    expect(h.render.mock.lastCall?.[1].id).toBe(other.id);
    expect(h.render.mock.lastCall?.[0]).toHaveLength(1);
    expect(h.button.hidden).toBe(true);
  });
});

it("marks a visible detail stale when workspace refresh fails and clears it only after a successful detail read", async () => {
  const { registry, workspace } = await fixture();
  const task = registry.createTask({ title: "Visible retained detail" }, "chatgpt-web", workspace);
  const elements = new Map<string, ReturnType<typeof element>>();
  function element() {
    return { hidden: false, textContent: "", className: "", value: "", title: "", dataset: {}, style: {},
      attributes: new Map<string, string>(), classList: { toggle: vi.fn() }, focus: vi.fn(),
      getClientRects: () => [], replaceChildren: vi.fn(), append: vi.fn(), querySelectorAll: () => [],
      querySelector: () => null, addEventListener: vi.fn(),
      setAttribute(name: string, value: string) { this.attributes.set(name, value); },
      removeAttribute(name: string) { this.attributes.delete(name); },
    };
  }
  function get(selector: string) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector)!;
  }
  vi.stubGlobal("window", { sessionStorage: null });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", { documentElement: { lang: "en" }, querySelector: get, querySelectorAll: () => [], getElementById: (id: string) => get(`#${id}`), createElement: element });
  const getTaskWorkspace = vi.fn(async () => registry.snapshot());
  const getTaskDetail = vi.fn(async () => registry.detail(task.id));
  const controller = new TasksController({ api: { getTaskWorkspace, getTaskDetail } as unknown as SovereignDesktopApi, notify: vi.fn() });
  await controller.openTask(task.id);
  expect(get("#task-detail-freshness").hidden).toBe(true);
  getTaskWorkspace.mockRejectedValueOnce(new Error("Workspace unavailable"));
  await expect(controller.refresh()).rejects.toThrow("Workspace unavailable");
  expect(get("#task-detail-freshness").hidden).toBe(false);
  expect(get("#task-detail-title").textContent).toBe("Visible retained detail");
  expect(get("#task-detail-layout").hidden).toBe(false);
  getTaskDetail.mockRejectedValueOnce(new Error("Detail unavailable"));
  await expect(controller.refresh()).rejects.toThrow("Detail unavailable");
  expect(get("#task-detail-freshness").hidden).toBe(false);
  await controller.refresh();
  expect(get("#task-detail-freshness").hidden).toBe(true);
});
