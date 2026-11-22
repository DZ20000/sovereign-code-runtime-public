import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRunRecord, DesktopRunSummary } from "../src/shared.js";
import { PythonController } from "../src/renderer/python-controller.js";
import { renderPythonView } from "../src/renderer/view-python.js";

const editorState = vi.hoisted(() => ({ source: "", measures: 0 }));
vi.mock("../src/renderer/code-editor.js", () => ({
  WorkbenchCodeEditor: class {
    getValue(): string { return editorState.source; }
    requestMeasure(): void { editorState.measures += 1; }
  },
}));

interface EventFixture {
  target: ElementFixture;
  key?: string;
  preventDefault: () => void;
}
class ElementFixture {
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  title = "";
  type = "";
  className = "";
  value = "";
  tabIndex = 0;
  focused = false;
  children: ElementFixture[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: EventFixture) => void)[]>();
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: (event: EventFixture) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
  }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.children = children; }
  focus(): void { this.focused = true; }
  emit(name: string, extra: Partial<EventFixture> = {}): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ target: this, preventDefault: () => {}, ...extra });
    }
  }
}
function domFixture(): (id: string) => ElementFixture {
  const nodes = new Map<string, ElementFixture>();
  for (const match of renderPythonView().matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gu)) {
    const node = new ElementFixture();
    node.hidden = /\bhidden\b/u.test(match[0]);
    node.disabled = /\bdisabled\b/u.test(match[0]);
    node.value = /\bvalue="([^"]*)"/u.exec(match[0])?.[1] ?? "";
    nodes.set("#" + match[1], node);
  }
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => nodes.get(selector) ?? null,
    createElement: () => new ElementFixture(),
  });
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  return (id: string): ElementFixture => {
    const node = nodes.get("#" + id);
    if (!node) throw new Error("Missing Python fixture element: " + id);
    return node;
  };
}
function run(id: string, state: DesktopRunRecord["state"] = "succeeded"): DesktopRunRecord {
  return {
    schemaVersion: "scr.run/v1", id, kind: "python", label: "Python script",
    workspaceId: "fixture-workspace", state, createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z", completedAt: state === "running" ? null : "2026-01-01T00:00:01Z",
    exitCode: state === "running" ? null : 0, signal: null, durationMs: 1000,
    outputTruncated: false, cancelRequested: false, metadata: {},
    stdout: "  <literal>你好</literal>\n" + id + "\n", stderr: "warning: " + id + "\n",
  };
}
function summary(record: DesktopRunRecord): DesktopRunSummary {
  const { stdout, stderr, ...base } = record;
  return { ...base, stdoutBytes: stdout.length, stderrBytes: stderr.length };
}
function apiFixture(record: DesktopRunRecord) {
  const invokeToolCalls = vi.fn((name: string, _input: Readonly<Record<string, unknown>>) => (
    name === "python.capabilities"
      ? { available: true, implementation: "CPython", version: "3.12.0", launcher: "python" }
      : record
  ));
  return {
    invokeTool: async <T>(name: string, input: Readonly<Record<string, unknown>>): Promise<T> =>
      invokeToolCalls(name, input) as T,
    invokeToolCalls,
    getRun: vi.fn(async (_id: string) => record),
    cancelRun: vi.fn(async (_id: string) => ({ ...record, cancelRequested: true })),
  };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers();
  editorState.source = "print('你好 <raw>')\n";
  editorState.measures = 0;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Python workbench", () => {
  it("keeps configuration, persistent output tabs and one bottom run action reachable in the template", () => {
    const html = renderPythonView();
    const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(20);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["python-code-editor", "python-cwd", "python-timeout", "python-artifacts",
      "python-artifact-entry", "python-artifact-chips", "python-runtime-title", "python-launcher",
      "python-version", "python-contract-result", "python-live-cancel", "python-live-details"]) {
      expect(ids).toContain(id);
    }
    expect(html).toMatch(/<section id="python-live-console"[^>]*>/u);
    expect(/<section id="python-live-console"[^>]*>/u.exec(html)?.[0]).not.toContain("hidden");
    for (const stream of ["stdout", "stderr"]) {
      expect(html).toContain('role="tab" aria-selected="' + (stream === "stdout") + '" aria-controls="python-live-' + stream + '"');
      expect(html).toContain('id="python-live-' + stream + '" role="tabpanel" aria-labelledby="python-output-tab-' + stream + '"');
    }
    expect(html.match(/\bbutton-primary\b/gu)).toHaveLength(1);
    expect(html.slice(html.indexOf('<footer class="v2-python-footer">'))).toContain('id="python-start-secondary"');
    expect(html).toContain('id="python-all-runs" class="button button-ghost" type="button" data-open-view="runs"');
  });

  it("switches output with keyboard access and preserves both raw streams and the selection during refresh", async () => {
    const node = domFixture(), record = run("python-current"), api = apiFixture(record);
    const controller = new PythonController({ api, notify: vi.fn() });
    controller.mount();
    controller.syncRuns([summary(record)]);
    await flush();
    const preventDefault = vi.fn();
    node("python-output-tab-stdout").emit("keydown", { key: "ArrowRight", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(node("python-output-tab-stderr").focused).toBe(true);
    expect(node("python-output-tab-stderr").attributes.get("aria-selected")).toBe("true");
    expect(node("python-output-tab-stdout").tabIndex).toBe(-1);
    expect(node("python-live-stdout").hidden).toBe(true);
    expect(node("python-live-stderr").hidden).toBe(false);
    expect(node("python-live-stdout").textContent).toBe(record.stdout);
    expect(node("python-live-stderr").textContent).toBe(record.stderr);
    const refreshing = controller.refresh();
    expect(node("python-refresh").disabled).toBe(true);
    await refreshing;
    expect(node("python-refresh").disabled).toBe(false);
    expect(node("python-output-tab-stderr").attributes.get("aria-selected")).toBe("true");
    expect(node("python-live-details").dataset.runId).toBe(record.id);
    expect(node("python-live-empty").hidden).toBe(true);
    node("python-output-tab-stderr").emit("keydown", { key: "Home" });
    expect(node("python-output-tab-stdout").focused).toBe(true);
    expect(node("python-live-stdout").hidden).toBe(false);
  });

  it("runs the unchanged editor source/configuration and cancels only its current run", async () => {
    const node = domFixture(), record = run("python-started", "running"), api = apiFixture(record);
    const onRunStarted = vi.fn();
    const controller = new PythonController({ api, notify: vi.fn(), onRunStarted });
    controller.mount();
    await controller.refresh();
    node("python-cwd").value = " src ";
    node("python-timeout").value = "120";
    node("python-artifacts").value = "out/summary.txt";
    node("python-artifact-entry").value = " out/totals.csv ";
    node("python-output-tab-stderr").emit("click");
    await controller.start();
    expect(api.invokeToolCalls).toHaveBeenLastCalledWith("python.start", {
      mode: "code", code: editorState.source, cwd: "src",
      artifactPaths: ["out/summary.txt", "out/totals.csv"], timeoutMs: 120000,
    });
    expect(onRunStarted).toHaveBeenCalledExactlyOnceWith(record);
    expect(node("python-artifact-entry").value).toBe("");
    expect(node("python-live-stdout").textContent).toBe(record.stdout);
    expect(node("python-live-stderr").textContent).toBe(record.stderr);
    expect(node("python-output-tab-stderr").attributes.get("aria-selected")).toBe("true");
    expect(node("python-live-details").dataset.runId).toBe(record.id);
    expect(node("python-all-runs").dataset.runId).toBeUndefined();
    node("python-live-cancel").emit("click");
    await flush();
    expect(api.cancelRun).toHaveBeenCalledExactlyOnceWith(record.id);
    expect(node("python-live-cancel").disabled).toBe(true);
  });

  it("does not expose stale output or a stale run-details target after switching runs", async () => {
    const node = domFixture(), a = run("python-a", "running"), b = run("python-b");
    const pendingA = deferred<DesktopRunRecord>(), pendingB = deferred<DesktopRunRecord>();
    const api = apiFixture(a);
    api.getRun.mockImplementation((id: string) => id === a.id ? pendingA.promise : pendingB.promise);
    const controller = new PythonController({ api, notify: vi.fn() });
    controller.mount();
    controller.syncRuns([summary(a)]);
    controller.syncRuns([summary(b)]);
    expect(node("python-live-details").disabled).toBe(true);
    expect(node("python-live-details").dataset.runId).toBeUndefined();
    expect(node("python-live-stdout").textContent).toBe("");
    pendingB.resolve(b);
    await flush();
    pendingA.resolve(a);
    await flush();
    expect(node("python-live-stdout").textContent).toBe(b.stdout);
    expect(node("python-live-details").dataset.runId).toBe(b.id);
    expect(node("python-live-cancel").disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
