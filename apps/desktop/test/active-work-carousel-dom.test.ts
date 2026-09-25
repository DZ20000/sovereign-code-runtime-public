import { describe, expect, it, vi } from "vitest";

import {
  ActiveWorkCarousel,
  type ActiveWorkItem,
} from "../src/renderer/active-work-carousel.js";

type TestListener = (event: Record<string, unknown>) => void;

class TestDocument {
  activeElement: TestElement | null = null;

  createElement(tagName: string): TestElement {
    return new TestElement(tagName, this);
  }
}

class TestElement {
  readonly attributes = new Map<string, string>();
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, TestListener[]>();
  className = "";
  disconnectCount = 0;
  clientHeight = 180;
  id = "";
  offsetWidth = 1;
  parentElement: TestElement | null = null;
  tabIndex = 0;
  textContent = "";
  type = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: TestDocument,
  ) {}

  get firstElementChild(): TestElement | null {
    return this.children[0] ?? null;
  }

  get nextElementSibling(): TestElement | null {
    if (this.parentElement === null) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  get classList() {
    const values = (): Set<string> =>
      new Set(this.className.split(/\s+/u).filter(Boolean));
    const commit = (next: Set<string>): void => {
      this.className = [...next].join(" ");
    };
    return {
      add: (...names: string[]): void => {
        const next = values();
        for (const name of names) next.add(name);
        commit(next);
      },
      contains: (name: string): boolean => values().has(name),
      remove: (...names: string[]): void => {
        const next = values();
        for (const name of names) next.delete(name);
        commit(next);
      },
    };
  }

  addEventListener(name: string, listener: TestListener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  append(...children: TestElement[]): void {
    for (const child of children) this.insertBefore(child, null);
  }

  insertBefore(child: TestElement, reference: TestElement | null): void {
    child.remove();
    child.parentElement = this;
    if (reference === null) {
      this.children.push(child);
      return;
    }
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error("Reference child was not found.");
    this.children.splice(index, 0, child);
  }

  emit(name: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id.length === 0 ? null : this.id;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  querySelector<T extends Element = Element>(selector: string): T | null {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    for (const child of this.children) {
      if (
        className !== null &&
        child.className.split(/\s+/u).includes(className)
      ) {
        return child as unknown as T;
      }
      const descendant = child.querySelector<T>(selector);
      if (descendant !== null) return descendant;
    }
    return null;
  }

  remove(): void {
    if (this.parentElement === null) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
    this.disconnectCount += 1;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  replaceChildren(...children: TestElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  setPointerCapture(_pointerId: number): void {}
}

function item(id: string): ActiveWorkItem {
  return {
    id: `task:${id}`,
    source: "task",
    title: `Task ${id}`,
    detail: "Live Agent heartbeat confirmed.",
    lane: "current",
    state: "running",
    stateLabel: "Running",
    tone: "active",
    taskId: id,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function selectedRows(root: TestElement): TestElement[] {
  return root.children.filter(
    (row) => row.getAttribute("aria-selected") === "true",
  );
}

describe("active work carousel DOM contract", () => {
  it("keeps listbox focus, index and exactly one selected option aligned", () => {
    const document = new TestDocument();
    const root = document.createElement("div");
    root.setAttribute("role", "listbox");
    const changes: Array<{
      readonly id: string | null;
      readonly total: number;
      readonly focusedIndex: number;
    }> = [];
    const carousel = new ActiveWorkCarousel(
      root as unknown as HTMLElement,
      {
        onSelectionChanged: (focused, total, focusedIndex) => {
          changes.push({ id: focused?.id ?? null, total, focusedIndex });
        },
      },
    );

    root.focus();
    carousel.update([item("one"), item("two"), item("three")]);

    expect(root.getAttribute("role")).toBe("listbox");
    expect(root.children).toHaveLength(3);
    expect(
      root.children.map((row) => row.getAttribute("role")),
    ).toEqual(["option", "option", "option"]);
    expect(selectedRows(root)).toHaveLength(1);
    expect(selectedRows(root)[0]?.dataset.activeWorkId).toBe("task:one");
    expect(root.getAttribute("aria-activedescendant")).toBe(
      selectedRows(root)[0]?.id,
    );
    expect(document.activeElement).toBe(root);
    expect(changes.at(-1)).toEqual({
      id: "task:one",
      total: 3,
      focusedIndex: 0,
    });

    const preventDefault = vi.fn();
    root.emit("keydown", {
      key: "ArrowDown",
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(root);
    expect(selectedRows(root)).toHaveLength(1);
    expect(selectedRows(root)[0]?.dataset.activeWorkId).toBe("task:two");
    expect(root.getAttribute("aria-activedescendant")).toBe(
      selectedRows(root)[0]?.id,
    );
    expect(changes.at(-1)).toEqual({
      id: "task:two",
      total: 3,
      focusedIndex: 1,
    });
  });

  it("keeps existing rows connected during wheel-driven movement", () => {
    const document = new TestDocument();
    const root = document.createElement("div");
    const carousel = new ActiveWorkCarousel(root as unknown as HTMLElement);
    carousel.update([item("one"), item("two"), item("three"), item("four")]);
    const initiallyMounted = [...root.children];
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    root.emit("wheel", {
      deltaMode: 0,
      deltaY: 120,
      preventDefault,
      stopPropagation,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(selectedRows(root)[0]?.dataset.activeWorkId).toBe("task:two");
    expect(initiallyMounted.map((row) => row.disconnectCount)).toEqual([0, 0, 0]);
    expect(root.children.map((row) => row.dataset.activeWorkId)).toEqual([
      "task:one",
      "task:two",
      "task:three",
      "task:four",
    ]);
  });

  it("keeps retained rows connected during snapshot-driven selection fallback", () => {
    const document = new TestDocument();
    const root = document.createElement("div");
    const carousel = new ActiveWorkCarousel(root as unknown as HTMLElement);
    const items = [item("one"), item("two"), item("three"), item("four")];
    carousel.update(items);
    const retained = root.children.filter((row) =>
      ["task:two", "task:three"].includes(row.dataset.activeWorkId ?? ""),
    );

    carousel.update(items.slice(1));

    expect(selectedRows(root)[0]?.dataset.activeWorkId).toBe("task:two");
    expect(retained.map((row) => row.disconnectCount)).toEqual([0, 0]);
    expect(root.children.map((row) => row.dataset.activeWorkId)).toEqual([
      "task:two",
      "task:three",
      "task:four",
    ]);
  });
});
