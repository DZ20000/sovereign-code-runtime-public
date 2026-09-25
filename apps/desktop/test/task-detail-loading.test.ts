import { describe, expect, it } from "vitest";

import {
  setTaskDetailLoading,
  type TaskDetailLoadingDocument,
} from "../src/renderer/task-detail-loading.js";

class FakeElement {
  hidden = false;
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

function fixture(): {
  readonly document: TaskDetailLoadingDocument;
  readonly elements: Map<string, FakeElement>;
} {
  const elements = new Map(
    [
      "task-detail-pane",
      "task-detail-loading",
      "task-detail-freshness",
      "task-detail-heading",
      "task-detail-heading-state",
      "task-detail-layout",
    ].map((id) => [id, new FakeElement()] as const),
  );
  elements.get("task-detail-loading")!.hidden = true;
  elements.get("task-detail-freshness")!.hidden = true;
  return {
    elements,
    document: {
      getElementById: (id) => elements.get(id) ?? null,
    },
  };
}

describe("task detail loading state", () => {
  it("hides stale detail regions and labels the pane with the loading status", () => {
    const { document, elements } = fixture();
    setTaskDetailLoading(document, "loading");

    const pane = elements.get("task-detail-pane")!;
    expect(pane.attributes.get("aria-busy")).toBe("true");
    expect(pane.attributes.get("aria-labelledby")).toBe(
      "task-detail-loading-label",
    );
    expect(pane.attributes.has("aria-describedby")).toBe(false);
    expect(elements.get("task-detail-loading")!.hidden).toBe(false);
    expect(elements.get("task-detail-freshness")!.hidden).toBe(true);
    expect(elements.get("task-detail-heading")!.hidden).toBe(true);
    expect(elements.get("task-detail-heading-state")!.hidden).toBe(true);
    expect(elements.get("task-detail-layout")!.hidden).toBe(true);
  });

  it("restores the trusted detail regions only after loading settles", () => {
    const { document, elements } = fixture();
    setTaskDetailLoading(document, "loading");
    setTaskDetailLoading(document, "ready");

    const pane = elements.get("task-detail-pane")!;
    expect(pane.attributes.has("aria-busy")).toBe(false);
    expect(pane.attributes.has("aria-describedby")).toBe(false);
    expect(pane.attributes.get("aria-labelledby")).toBe("task-detail-title");
    expect(elements.get("task-detail-loading")!.hidden).toBe(true);
    expect(elements.get("task-detail-freshness")!.hidden).toBe(true);
    expect(elements.get("task-detail-heading")!.hidden).toBe(false);
    expect(elements.get("task-detail-heading-state")!.hidden).toBe(false);
    expect(elements.get("task-detail-layout")!.hidden).toBe(false);
  });

  it("keeps last known detail visible while marking an unavailable snapshot", () => {
    const { document, elements } = fixture();
    setTaskDetailLoading(document, "unavailable");

    const pane = elements.get("task-detail-pane")!;
    expect(pane.attributes.has("aria-busy")).toBe(false);
    expect(pane.attributes.get("aria-labelledby")).toBe("task-detail-title");
    expect(pane.attributes.get("aria-describedby")).toBe(
      "task-detail-freshness",
    );
    expect(elements.get("task-detail-loading")!.hidden).toBe(true);
    expect(elements.get("task-detail-freshness")!.hidden).toBe(false);
    expect(elements.get("task-detail-heading")!.hidden).toBe(false);
    expect(elements.get("task-detail-heading-state")!.hidden).toBe(false);
    expect(elements.get("task-detail-layout")!.hidden).toBe(false);
  });

  it("fails closed when the expected loading structure is incomplete", () => {
    const { document, elements } = fixture();
    elements.delete("task-detail-layout");
    expect(() => setTaskDetailLoading(document, "loading")).toThrow(
      "Required task detail loading element is missing: #task-detail-layout",
    );
  });
});
