import type {
  DesktopTaskListItem,
  DesktopTaskWorkspaceSnapshot,
} from "../shared.js";
import {
  boundedDisplayLine,
  setAttributeIfChanged,
  setClassIfChanged,
  setTextIfChanged,
} from "./output-follow.js";
import {
  taskBoardLane,
  taskHasLiveAgent,
  taskBoardState,
  taskBoardStateDetail,
  taskBoardStateLabel,
  type TaskBoardState,
} from "./task-board-model.js";

export type ActiveWorkSource = "task";
export type ActiveWorkTone = "active" | "attention" | "neutral";

export interface ActiveWorkItem {
  readonly id: string;
  readonly source: ActiveWorkSource;
  readonly title: string;
  readonly detail: string;
  readonly lane: "current" | "attention";
  readonly state: TaskBoardState;
  readonly stateLabel: string;
  readonly tone: ActiveWorkTone;
  readonly taskId: string;
  readonly updatedAt: string;
}

export interface ActiveWorkBuildInput {
  readonly taskWorkspace: DesktopTaskWorkspaceSnapshot | null;
  readonly limit?: number;
}

export interface ActiveWorkSelection {
  readonly focusedId: string | null;
  readonly focusedIndex: number;
}

function activeWorkSourceLabel(_source: ActiveWorkSource): string {
  return "Task";
}

export function activeWorkPositionLabel(
  total: number,
  focusedIndex: number,
): string {
  if (total < 1 || focusedIndex < 0) {
    const boundedTotal = Math.max(0, total);
    return `${boundedTotal} item${boundedTotal === 1 ? "" : "s"}`;
  }
  return `${Math.min(total, focusedIndex + 1)} / ${total}`;
}

function activeWorkAriaLabel(item: ActiveWorkItem): string {
  return [
    activeWorkSourceLabel(item.source),
    item.title,
    item.detail,
    item.stateLabel,
  ].join(". ");
}

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskItem(
  task: DesktopTaskListItem,
  lane: "current" | "attention",
): ActiveWorkItem {
  const state = taskBoardState(task);
  return {
    id: `task:${task.id}`,
    source: "task",
    title: boundedDisplayLine(task.title, 96) || "Untitled task",
    detail: taskBoardStateDetail(task),
    lane,
    state,
    stateLabel: taskBoardStateLabel(task),
    tone: lane === "attention" ? "attention" : taskHasLiveAgent(task) ? "active" : "neutral",
    taskId: task.id,
    updatedAt: task.lastActivityAt ?? task.updatedAt,
  };
}

export function buildActiveWorkItems(
  input: ActiveWorkBuildInput,
): readonly ActiveWorkItem[] {
  const taskItemsById = new Map<string, ActiveWorkItem>();
  for (const task of (input.taskWorkspace?.projects ?? []).flatMap(
    (project) => project.tasks,
  )) {
    const lane = taskBoardLane(task);
    if (lane !== "current" && lane !== "attention") continue;
    const candidate = taskItem(task, lane);
    const existing = taskItemsById.get(candidate.id);
    if (
      existing === undefined ||
      timestamp(candidate.updatedAt) >= timestamp(existing.updatedAt)
    ) {
      taskItemsById.set(candidate.id, candidate);
    }
  }
  const taskItems = [...taskItemsById.values()];
  const rank = (item: ActiveWorkItem): number =>
    item.lane === "attention" ? 0 : 1;
  return taskItems
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, input.limit ?? 9);
}

export function reconcileActiveWorkSelection(
  items: readonly ActiveWorkItem[],
  previousFocusedId: string | null,
  previousIndex = 0,
  preferFirst = false,
): ActiveWorkSelection {
  if (items.length === 0) return { focusedId: null, focusedIndex: -1 };
  if (preferFirst) return { focusedId: items[0]?.id ?? null, focusedIndex: 0 };
  const retained =
    previousFocusedId === null
      ? -1
      : items.findIndex((item) => item.id === previousFocusedId);
  const focusedIndex =
    retained >= 0
      ? retained
      : Math.max(0, Math.min(previousIndex, items.length - 1));
  return { focusedId: items[focusedIndex]?.id ?? null, focusedIndex };
}

export function moveActiveWorkSelection(
  items: readonly ActiveWorkItem[],
  focusedId: string | null,
  delta: number,
): ActiveWorkSelection {
  const current = reconcileActiveWorkSelection(items, focusedId);
  if (current.focusedIndex < 0 || items.length === 0) return current;
  const next = Math.max(
    0,
    Math.min(items.length - 1, current.focusedIndex + Math.sign(delta)),
  );
  return { focusedId: items[next]?.id ?? null, focusedIndex: next };
}

export function visibleActiveWorkItems(
  items: readonly ActiveWorkItem[],
  focusedId: string | null,
  radius = 2,
): readonly { readonly item: ActiveWorkItem; readonly offset: number }[] {
  const selection = reconcileActiveWorkSelection(items, focusedId);
  if (selection.focusedIndex < 0) return [];
  const start = Math.max(0, selection.focusedIndex - radius);
  const end = Math.min(items.length, selection.focusedIndex + radius + 1);
  return items.slice(start, end).map((item, index) => ({
    item,
    offset: start + index - selection.focusedIndex,
  }));
}

interface ActiveWorkCarouselOptions {
  readonly onActivate?: (item: ActiveWorkItem) => void;
  readonly onSelectionChanged?: (
    item: ActiveWorkItem | null,
    total: number,
    focusedIndex: number,
  ) => void;
}

export class ActiveWorkCarousel {
  readonly #root: HTMLElement;
  readonly #options: ActiveWorkCarouselOptions;
  readonly #rows = new Map<string, HTMLButtonElement>();
  #items: readonly ActiveWorkItem[] = [];
  #focusedId: string | null = null;
  #focusedIndex = 0;
  #selectionPinned = false;
  #signature = "";
  #pointerStartY: number | null = null;
  #wheelAccumulator = 0;

  constructor(root: HTMLElement, options: ActiveWorkCarouselOptions = {}) {
    this.#root = root;
    this.#options = options;
    root.addEventListener("keydown", (event) => this.#onKeyDown(event));
    root.addEventListener("wheel", (event) => this.#onWheel(event), {
      passive: false,
    });
    root.addEventListener("pointerdown", (event) => {
      this.#pointerStartY = event.clientY;
      root.setPointerCapture?.(event.pointerId);
    });
    root.addEventListener("pointerup", (event) => {
      if (this.#pointerStartY === null) return;
      const delta = this.#pointerStartY - event.clientY;
      this.#pointerStartY = null;
      if (Math.abs(delta) >= 28) this.move(delta > 0 ? 1 : -1);
    });
    const cancelPointerDrag = (): void => {
      this.#pointerStartY = null;
    };
    root.addEventListener("pointercancel", cancelPointerDrag);
    root.addEventListener("lostpointercapture", cancelPointerDrag);
    root.addEventListener("animationend", (event) => {
      if (!event.animationName.startsWith("active-work-boundary-")) return;
      this.#clearBoundaryNudge();
    });
  }

  get focusedItem(): ActiveWorkItem | null {
    return this.#items.find((item) => item.id === this.#focusedId) ?? null;
  }

  #notifySelection(): void {
    this.#options.onSelectionChanged?.(
      this.focusedItem,
      this.#items.length,
      this.#focusedIndex,
    );
  }

  update(items: readonly ActiveWorkItem[]): ActiveWorkItem | null {
    const selection = reconcileActiveWorkSelection(
      items,
      this.#focusedId,
      this.#focusedIndex,
      this.#focusedId === null && !this.#selectionPinned,
    );
    this.#items = items;
    if (items.length === 0) this.#selectionPinned = false;
    this.#focusedId = selection.focusedId;
    this.#focusedIndex = selection.focusedIndex;
    this.#render();
    this.#notifySelection();
    return this.focusedItem;
  }

  move(delta: number): ActiveWorkItem | null {
    this.#selectionPinned = true;
    const selection = moveActiveWorkSelection(
      this.#items,
      this.#focusedId,
      delta,
    );
    if (selection.focusedId === this.#focusedId) {
      if (delta !== 0) this.#nudgeBoundary(delta);
      return this.focusedItem;
    }
    this.#clearBoundaryNudge();
    this.#focusedId = selection.focusedId;
    this.#focusedIndex = selection.focusedIndex;
    this.#signature = "";
    this.#render();
    this.#notifySelection();
    return this.focusedItem;
  }

  focusItem(id: string): ActiveWorkItem | null {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index < 0) return this.focusedItem;
    this.#selectionPinned = true;
    this.#focusedId = id;
    this.#focusedIndex = index;
    this.#signature = "";
    this.#render();
    this.#notifySelection();
    return this.focusedItem;
  }

  activateFocused(): void {
    const item = this.focusedItem;
    if (item !== null) this.#options.onActivate?.(item);
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      this.move(-1);
    } else if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      this.move(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      this.focusItem(this.#items[0]?.id ?? "");
    } else if (event.key === "End") {
      event.preventDefault();
      this.focusItem(this.#items.at(-1)?.id ?? "");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateFocused();
    }
  }

  #clearBoundaryNudge(): void {
    this.#root.classList.remove("is-boundary-before", "is-boundary-after");
  }

  #nudgeBoundary(delta: number): void {
    const className = delta < 0 ? "is-boundary-before" : "is-boundary-after";
    this.#clearBoundaryNudge();
    // Restart the small resistance animation for repeated wheel or swipe input.
    void this.#root.offsetWidth;
    this.#root.classList.add(className);
  }

  #onWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;

    // A vertical wheel gesture that starts on Active Work always belongs to the
    // task navigator. Consume it before checking bounds so the same gesture can
    // never fall through to the page at the first or last task.
    event.preventDefault();
    event.stopPropagation();

    const direction = Math.sign(event.deltaY);
    if (this.#items.length < 2) {
      this.#wheelAccumulator = 0;
      this.#nudgeBoundary(direction);
      return;
    }

    const selection = reconcileActiveWorkSelection(
      this.#items,
      this.#focusedId,
      this.#focusedIndex,
    );
    const atBoundary =
      direction < 0
        ? selection.focusedIndex <= 0
        : selection.focusedIndex >= this.#items.length - 1;
    if (atBoundary) {
      this.#wheelAccumulator = 0;
      this.#nudgeBoundary(direction);
      return;
    }

    const normalizedDelta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * Math.max(1, this.#root.clientHeight)
          : event.deltaY;
    if (
      this.#wheelAccumulator !== 0 &&
      Math.sign(this.#wheelAccumulator) !== direction
    ) {
      this.#wheelAccumulator = 0;
    }
    this.#wheelAccumulator += normalizedDelta;
    if (Math.abs(this.#wheelAccumulator) < 24) return;
    this.move(this.#wheelAccumulator > 0 ? 1 : -1);
    this.#wheelAccumulator = 0;
  }

  #row(item: ActiveWorkItem): HTMLButtonElement {
    const existing = this.#rows.get(item.id);
    if (existing !== undefined) return existing;
    const document = this.#root.ownerDocument;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "active-work-line";
    row.setAttribute("role", "option");
    row.dataset.activeWorkId = item.id;
    const marker = document.createElement("span");
    marker.className = "active-work-line-marker";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "active-work-line-copy";
    const source = document.createElement("span");
    source.className = "active-work-line-source";
    const title = document.createElement("strong");
    title.className = "active-work-line-title";
    const detail = document.createElement("span");
    detail.className = "active-work-line-detail";
    const state = document.createElement("span");
    state.className = "active-work-line-state";
    const stateDot = document.createElement("span");
    stateDot.className = "active-work-line-state-dot";
    stateDot.setAttribute("aria-hidden", "true");
    const stateLabel = document.createElement("span");
    stateLabel.className = "active-work-line-state-label";
    copy.append(source, title, detail);
    state.append(stateDot, stateLabel);
    row.append(marker, copy, state);
    row.addEventListener("click", () => {
      if (this.#focusedId === item.id) this.#options.onActivate?.(item);
      else this.focusItem(item.id);
    });
    this.#rows.set(item.id, row);
    return row;
  }

  #syncRowOrder(orderedRows: readonly HTMLButtonElement[]): void {
    let current = this.#root.firstElementChild;
    for (const row of orderedRows) {
      if (row === current) {
        current = current.nextElementSibling;
        continue;
      }
      // Reparent only rows that are genuinely out of order. Re-appending every
      // connected row after its offset class changes makes WebView2 discard the
      // previous rendered transform, so normal carousel moves snap to the final
      // position instead of interpolating.
      this.#root.insertBefore(row, current);
    }
  }

  #render(): void {
    const visible = visibleActiveWorkItems(this.#items, this.#focusedId);
    const signature = JSON.stringify(
      visible.map(({ item, offset }) => [
        item.id,
        item.title,
        item.detail,
        item.state,
        item.stateLabel,
        item.tone,
        offset,
      ]),
    );
    if (signature === this.#signature) return;
    this.#signature = signature;
    const visibleIds = new Set(visible.map(({ item }) => item.id));
    for (const [id, row] of this.#rows) {
      if (!visibleIds.has(id)) {
        row.remove();
        this.#rows.delete(id);
      }
    }
    if (visible.length === 0) {
      let empty = this.#root.querySelector<HTMLElement>(".active-work-empty");
      if (empty === null) {
        empty = this.#root.ownerDocument.createElement("div");
        empty.className = "active-work-empty";
        this.#root.replaceChildren(empty);
      }
      setTextIfChanged(empty, "No active work");
      setAttributeIfChanged(this.#root, "aria-activedescendant", null);
      return;
    }
    this.#root.querySelector(".active-work-empty")?.remove();
    const orderedRows: HTMLButtonElement[] = [];
    for (const { item, offset } of visible) {
      const row = this.#row(item);
      const selected = offset === 0;
      setClassIfChanged(
        row,
        `active-work-line active-work-line-${item.tone} active-work-source-${item.source} active-work-offset-${offset < 0 ? `minus-${Math.abs(offset)}` : `plus-${offset}`}${selected ? " is-focused" : ""}`,
      );
      setAttributeIfChanged(row, "aria-selected", selected ? "true" : "false");
      setAttributeIfChanged(
        row,
        "aria-posinset",
        String(this.#focusedIndex + offset + 1),
      );
      setAttributeIfChanged(row, "aria-setsize", String(this.#items.length));
      setAttributeIfChanged(row, "tabindex", "-1");
      setAttributeIfChanged(row, "aria-label", activeWorkAriaLabel(item));
      row.id = `active-work-${item.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
      setTextIfChanged(
        row.querySelector<HTMLElement>(".active-work-line-source")!,
        activeWorkSourceLabel(item.source),
      );
      setTextIfChanged(
        row.querySelector<HTMLElement>(".active-work-line-title")!,
        item.title,
      );
      setTextIfChanged(
        row.querySelector<HTMLElement>(".active-work-line-detail")!,
        item.detail,
      );
      setTextIfChanged(
        row.querySelector<HTMLElement>(".active-work-line-state-label")!,
        item.stateLabel,
      );
      orderedRows.push(row);
    }
    this.#syncRowOrder(orderedRows);
    const focused = orderedRows.find(
      (row) => row.getAttribute("aria-selected") === "true",
    );
    setAttributeIfChanged(
      this.#root,
      "aria-activedescendant",
      focused?.id ?? null,
    );
  }
}
