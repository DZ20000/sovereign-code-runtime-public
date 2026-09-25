import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopTaskListItem, DesktopTaskProjectSummary } from "../src/shared.js";
import {
  groupTaskProjects,
  readTaskProjectGroups,
  renderTaskProjectGroupManager,
  writeTaskProjectGroups,
  type TaskProjectGroup,
} from "../src/renderer/task-project-groups.js";

function project(id: string, overrides: Partial<DesktopTaskProjectSummary> = {}): DesktopTaskProjectSummary {
  const task: DesktopTaskListItem = {
    id: `task-${id}`, title: id, category: "development", status: "running", source: "agent",
    summaryPreview: "", currentStep: "", progress: { current: null, total: null, label: null },
    agent: { id: "shared-agent", name: "Agent", presence: "online", lastHeartbeatAt: "2026-09-08T00:00:00Z" },
    lastActivityLabel: null, lastActivityAt: null, unreadUserMessageCount: 0,
    coordinationPendingCount: 0, messageCount: 0, updatedAt: "2026-09-08T00:00:00Z",
  };
  return {
    id, name: "Same project name", root: `E:\\${id}`, status: "active", taskCount: 1,
    activeTaskCount: 1, attentionTaskCount: 0, onlineAgentCount: 1,
    updatedAt: task.updatedAt, tasks: [task], ...overrides,
  };
}

function storage(initial: string | null = null) {
  let current = initial;
  return {
    getItem: vi.fn(() => current),
    setItem: vi.fn((_key: string, value: string) => { current = value; }),
  };
}

const first = project("first");
const second = project("second", { attentionTaskCount: 1, updatedAt: "2026-09-08T01:00:00Z" });
const unrelated = project("unrelated");
const group: TaskProjectGroup = { id: "first", name: "Combined", projectIds: ["first", "second"] };

afterEach(() => vi.unstubAllGlobals());

describe("explicit task project display groups", () => {
  it("combines every member without changing identities, roots, task objects or the original collection", () => {
    const originals = [second, unrelated, first];
    const before = structuredClone(originals);
    const merged = groupTaskProjects(originals, [group]);
    expect(merged.map((entry) => entry.id)).toEqual(["first", "unrelated"]);
    expect(merged[0]).toMatchObject({
      id: first.id, name: "Combined", root: first.root, status: "attention",
      taskCount: 2, activeTaskCount: 2, attentionTaskCount: 1, onlineAgentCount: 1,
      updatedAt: second.updatedAt,
    });
    expect(merged[0]!.tasks).toEqual([first.tasks[0], second.tasks[0]]);
    expect(merged[0]!.tasks[0]).toBe(first.tasks[0]);
    expect(merged[1]).toBe(unrelated);
    expect(originals).toEqual(before);
    expect(groupTaskProjects([first, second], [group])[0]!.tasks).toEqual(merged[0]!.tasks);
    expect(groupTaskProjects(originals, [])).toBe(originals);
  });

  it("keeps original projects available for corrupt, overlapping or unavailable group members", () => {
    const projects = [first, second, unrelated];
    expect(groupTaskProjects(projects, [group, { ...group, id: "second" }])).toBe(projects);
    expect(groupTaskProjects(projects, [{ ...group, projectIds: ["first", "missing"] }])).toEqual(projects);
    const broken = storage("{invalid json");
    expect(readTaskProjectGroups(broken)).toEqual([]);
    expect(broken.setItem).not.toHaveBeenCalled();
    expect(readTaskProjectGroups(storage(JSON.stringify([{ ...group, name: "bad\nname" }])))).toEqual([]);
  });

  it("validates selections before persistence and leaves existing preferences intact on failure", () => {
    const saved = storage();
    writeTaskProjectGroups([group], [first, second], saved);
    expect(readTaskProjectGroups(saved)).toEqual([group]);
    for (const groups of [
      [{ ...group, projectIds: ["first"] }],
      [{ ...group, projectIds: ["first", "first"] }],
      [{ ...group, projectIds: ["first", "unknown"] }],
      [{ ...group, name: " " }],
      [group, { id: "second", name: "Overlap", projectIds: ["second", "unrelated"] }],
    ]) {
      expect(() => writeTaskProjectGroups(groups, [first, second, unrelated], saved)).toThrow("Choose at least");
      expect(readTaskProjectGroups(saved)).toEqual([group]);
    }
    expect(saved.setItem).toHaveBeenCalledTimes(1);
    saved.setItem.mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(() => writeTaskProjectGroups([], [first, second], saved)).toThrow("Storage unavailable");
    expect(readTaskProjectGroups(saved)).toEqual([group]);
  });
});

class TestElement {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  readonly ownerDocument = { createElement: (tag: string) => new TestElement(tag) };
  textContent = "";
  value = "";
  open = false;
  checked = false;
  disabled = false;
  focusCount = 0;
  constructor(readonly tagName: string) {}
  append(...nodes: TestElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: TestElement[]) { this.children.splice(0, this.children.length, ...nodes); }
  contains(node: TestElement): boolean { return this === node || this.children.some((child) => child.contains(node)); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
  emit(type: string) { this.listeners.get(type)?.({ preventDefault() {} }); }
  focus() { this.focusCount += 1; }
  find(predicate: (node: TestElement) => boolean): TestElement {
    const found = this.all().find(predicate);
    if (!found) throw new Error("Expected test element was not rendered");
    return found;
  }
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}

describe("project grouping editor", () => {
  it("retains an open draft across refreshes, saves explicitly, and reverses only the display preference", () => {
    const saved = storage();
    vi.stubGlobal("window", { localStorage: saved });
    const container = new TestElement("div");
    const onChange = vi.fn();
    const render = (projects: readonly DesktopTaskProjectSummary[]) => renderTaskProjectGroupManager({
      container: container as unknown as HTMLElement, projects, onChange,
    });
    render([first, second]);
    const details = container.find((node) => node.tagName === "details");
    render([{ ...second, updatedAt: "2026-09-08T02:00:00Z" }, first]);
    expect(container.children[0]).toBe(details);
    details.open = true;
    const name = container.find((node) => "taskProjectGroupName" in node.dataset);
    name.value = "My group";
    for (const node of container.all()) if ("taskProjectGroupMember" in node.dataset) node.checked = true;
    render([second, unrelated, first]);
    expect(container.children[0]).toBe(details);
    expect(name.value).toBe("My group");
    expect(saved.setItem).not.toHaveBeenCalled();
    container.find((node) => node.tagName === "form").emit("submit");
    expect(readTaskProjectGroups(saved)).toEqual([{ ...group, name: "My group" }]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(container.find((node) => node.tagName === "details").open).toBe(true);
    expect(container.find((node) => node.tagName === "summary").focusCount).toBe(1);
    expect(container.all().some((node) => node.dataset.taskProjectGroupMember === unrelated.id)).toBe(true);
    container.find((node) => "taskProjectGroupRemove" in node.dataset).emit("click");
    expect(readTaskProjectGroups(saved)).toEqual([]);
    expect(groupTaskProjects([first, second], readTaskProjectGroups(saved))).toEqual([first, second]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(container.find((node) => node.tagName === "summary").focusCount).toBe(1);
  });

  it("shows save failures without losing the draft or announcing a change", () => {
    const saved = storage();
    saved.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
    vi.stubGlobal("window", { localStorage: saved });
    const container = new TestElement("div");
    const onChange = vi.fn();
    renderTaskProjectGroupManager({ container: container as unknown as HTMLElement, projects: [first, second], onChange });
    container.find((node) => node.tagName === "details").open = true;
    const name = container.find((node) => "taskProjectGroupName" in node.dataset);
    name.value = "Draft";
    for (const node of container.all()) if ("taskProjectGroupMember" in node.dataset) node.checked = true;
    container.find((node) => node.tagName === "form").emit("submit");
    expect(name.value).toBe("Draft");
    expect(container.find((node) => node.attributes.get("role") === "alert").textContent).toContain("Could not save");
    expect(onChange).not.toHaveBeenCalled();
    expect(readTaskProjectGroups(saved)).toEqual([]);
  });
});
