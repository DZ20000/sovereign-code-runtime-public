import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopRunRecord, DesktopRunSummary } from "../src/shared.js";
import { RunsController } from "../src/renderer/runs-controller.js";

class ElementFixture {
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  type = "";
  className = "";
  children: ElementFixture[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: { target: ElementFixture }) => void)[]>();
  readonly classList = { toggle: (_name: string, _value?: boolean) => undefined };
  readonly values: ElementFixture[] = [];
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, handler: (event: { target: ElementFixture }) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
  }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.children = children; }
  querySelectorAll(): ElementFixture[] { return this.values; }
  contains(other: ElementFixture): boolean { return this.children.includes(other); }
  closest(): ElementFixture | null { return this.dataset.runId ? this : null; }
  focus(): void { /* The renderer test harness verifies actual browser focus. */ }
  click(target: ElementFixture = this): void {
    for (const listener of this.listeners.get("click") ?? []) listener({ target });
  }
}

function domFixture(): Map<string, ElementFixture> {
  const nodes = new Map<string, ElementFixture>();
  const get = (selector: string): ElementFixture => {
    let node = nodes.get(selector);
    if (!node) { node = new ElementFixture(); nodes.set(selector, node); }
    return node;
  };
  get("#run-detail-meta").values.push(...Array.from({ length: 4 }, () => new ElementFixture()));
  vi.stubGlobal("HTMLElement", ElementFixture);
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal("document", {
    documentElement: { lang: "en" }, activeElement: null,
    querySelector: get, createElement: () => new ElementFixture(),
  });
  return nodes;
}

function run(id: string, taskId?: string, state: DesktopRunRecord["state"] = "succeeded"): DesktopRunRecord {
  return {
    schemaVersion: "scr.run/v1", id, kind: "terminal", label: id,
    workspaceId: "same-workspace", state, createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z", completedAt: state === "running" ? null : "2026-01-01T00:00:01Z",
    exitCode: state === "running" ? null : 0, signal: null, durationMs: 1000,
    outputTruncated: false, cancelRequested: false,
    metadata: taskId === undefined ? {} : { taskId }, stdout: `output for ${id}`, stderr: "",
  };
}

function summary(record: DesktopRunRecord): DesktopRunSummary {
  const { stdout, stderr, ...base } = record;
  return { ...base, stdoutBytes: stdout.length, stderrBytes: stderr.length };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => vi.unstubAllGlobals());

describe("Runs within Tasks", () => {
  it("scopes output while keeping overview summaries and the active run global", async () => {
    const nodes = domFixture();
    const records = [run("other-active", "task-b", "running"), run("linked", "task-a"), run("legacy")];
    const summaries = records.map(summary);
    const onSummariesChanged = vi.fn();
    const onActiveRunChanged = vi.fn();
    const api = {
      getRuns: vi.fn(async () => summaries),
      getRun: vi.fn(async (id: string) => records.find((item) => item.id === id)!),
      cancelRun: vi.fn(),
    };
    const controller = new RunsController({ api, notify: vi.fn(), onSummariesChanged, onActiveRunChanged });
    controller.mount();
    controller.setTaskScope("task-a");
    await controller.refresh();
    expect(nodes.get("#runs-list")!.children.map((node) => node.dataset.runId)).toEqual(["linked"]);
    expect(nodes.get("#run-stdout")!.textContent).toBe("output for linked");
    expect(onSummariesChanged).toHaveBeenLastCalledWith(summaries);
    expect(onActiveRunChanged).toHaveBeenLastCalledWith(records[0], 1);

    controller.setTaskScope("absent");
    expect(nodes.get("#runs-empty-title")!.textContent).toBe("No associated runs yet");
    expect(nodes.get("#run-scope-all")!.hidden).toBe(false);
    expect(nodes.get("#run-stdout")!.textContent).toBe("Select a run to inspect output.");
    controller.setTaskScope(null);
    await flush();
    expect(nodes.get("#runs-list")!.children.map((node) => node.dataset.runId)).toEqual(["other-active", "linked", "legacy"]);
    expect(nodes.get("#run-scope-all")!.hidden).toBe(true);
  });

  it("rejects late task-A output after switching to task B", async () => {
    const nodes = domFixture();
    const a = run("run-a", "task-a");
    const b = run("run-b", "task-b");
    const api = {
      getRuns: vi.fn(async () => [summary(a), summary(b)]),
      getRun: vi.fn(async (id: string) => id === a.id ? a : b), cancelRun: vi.fn(),
    };
    const controller = new RunsController({ api, notify: vi.fn() });
    controller.mount();
    await controller.refresh();
    const pendingA = deferred<DesktopRunRecord>();
    const pendingB = deferred<DesktopRunRecord>();
    api.getRun.mockImplementation((id: string) => id === a.id ? pendingA.promise : pendingB.promise);
    controller.setTaskScope("task-a");
    controller.setTaskScope("task-b");
    pendingB.resolve(b);
    await flush();
    expect(nodes.get("#run-stdout")!.textContent).toBe(b.stdout);
    pendingA.resolve(a);
    await flush();
    expect(nodes.get("#run-detail-title")!.textContent).toBe(b.label);
    expect(nodes.get("#run-stdout")!.textContent).toBe(b.stdout);
  });

  it("does not accept a mismatched detail claim and cancels only the selected run", async () => {
    const nodes = domFixture();
    const a = run("run-a", "task-a", "running");
    const b = run("run-b", "task-b", "running");
    const api = {
      getRuns: vi.fn(async () => [summary(a), summary(b)]),
      getRun: vi.fn(async (id: string) => id === a.id ? a : b),
      cancelRun: vi.fn(async (id: string) => ({ ...(id === a.id ? a : b), cancelRequested: true })),
    };
    const controller = new RunsController({ api, notify: vi.fn() });
    controller.mount();
    controller.setTaskScope("task-a");
    await controller.refresh();
    nodes.get("#run-cancel")!.click();
    await flush();
    expect(api.cancelRun).toHaveBeenCalledExactlyOnceWith("run-a");
    api.getRun.mockImplementation(async (id: string) => id === a.id ? { ...a, metadata: { taskId: "task-b" } } : b);
    controller.setTaskScope("task-b");
    controller.setTaskScope("task-a");
    await flush();
    expect(nodes.get("#run-cancel")!.disabled).toBe(true);
    expect(nodes.get("#run-stdout")!.textContent).toBe("Select a run to inspect output.");
  });
});
