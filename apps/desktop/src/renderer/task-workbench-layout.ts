const WIDTHS_KEY = "sovereign:task-workbench-widths:v1";

export function taskPaneWidth(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const width = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.max(minimum, Math.min(Math.max(minimum, maximum), width)));
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Task workbench element is missing: ${selector}`);
  return found;
}

export function setTaskWorkbenchSelection(taskId: string | null): void {
  element(".task-hub-shell").dataset.taskSelected = String(taskId !== null);
  element("#task-workbench-empty").hidden = taskId !== null;
  for (const popover of document.querySelectorAll<HTMLElement>(".task-workbench-popover:popover-open")) {
    popover.hidePopover();
  }
  for (const row of document.querySelectorAll<HTMLElement>(".task-summary-card[data-task-id]")) {
    if (row.dataset.taskId === taskId) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

export function mountTaskWorkbenchLayout(): void {
  const shell = element(".application-shell");
  const workbench = element(".task-hub-shell");
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) saved = value as Record<string, unknown>;
  } catch { /* Unavailable or malformed preferences use the default layout. */ }
  const widths = {
    navigation: taskPaneWidth(saved.navigation, 164, 320, 196),
    tasks: taskPaneWidth(saved.tasks, 300, 620, 360),
  };
  const persist = (): void => {
    try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths)); }
    catch { /* Resizing still works when browser storage is unavailable. */ }
  };
  const popovers = [
    [element("#task-steps-toggle"), element("#task-steps-popover")],
    [element("#task-info-toggle"), element("#task-info-popover")],
  ] as const;
  const positionPopover = (button: HTMLElement, popover: HTMLElement): void => {
    const anchor = button.getBoundingClientRect();
    const top = Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - 160));
    popover.style.top = `${top}px`;
    popover.style.right = `${Math.max(12, window.innerWidth - anchor.right)}px`;
    popover.style.maxHeight = `${window.innerHeight - top - 12}px`;
  };
  for (const [button, popover] of popovers) {
    popover.addEventListener("beforetoggle", (event) => {
      if ((event as ToggleEvent).newState === "open") positionPopover(button, popover);
    });
  }
  const panes = [
    { key: "navigation", handle: element("#task-navigation-resizer"), target: shell, property: "--ui-sidebar-width", minimum: 164, maximum: () => Math.min(320, window.innerWidth - 720) },
    { key: "tasks", handle: element("#task-list-resizer"), target: workbench, property: "--task-list-width", minimum: 300, maximum: () => Math.min(620, workbench.clientWidth - 340) },
  ] as const;
  const sync = (): void => {
    if (workbench.clientWidth === 0) return;
    workbench.classList.toggle("is-compact", workbench.clientWidth < 720);
    for (const pane of panes) {
      const width = taskPaneWidth(widths[pane.key], pane.minimum, pane.maximum(), widths[pane.key]);
      pane.target.style.setProperty(pane.property, `${width}px`);
      pane.handle.setAttribute("aria-valuemin", String(pane.minimum));
      pane.handle.setAttribute("aria-valuemax", String(Math.max(pane.minimum, pane.maximum())));
      pane.handle.setAttribute("aria-valuenow", String(width));
    }
    for (const [button, popover] of popovers) {
      if (popover.matches(":popover-open")) positionPopover(button, popover);
    }
  };
  for (const pane of panes) {
    let drag: { id: number; start: number; width: number } | null = null;
    const resize = (width: number): void => {
      widths[pane.key] = taskPaneWidth(width, pane.minimum, pane.maximum(), widths[pane.key]);
      sync();
    };
    pane.handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      pane.handle.focus({ preventScroll: true });
      drag = { id: event.pointerId, start: event.clientX, width: Number(pane.handle.getAttribute("aria-valuenow")) };
      pane.handle.setPointerCapture(event.pointerId);
      shell.classList.add("is-resizing-task-panes");
    });
    pane.handle.addEventListener("pointermove", (event) => {
      if (drag?.id === event.pointerId) resize(drag.width + event.clientX - drag.start);
    });
    const finish = (): void => {
      if (drag === null) return;
      const pointerId = drag.id;
      drag = null;
      shell.classList.remove("is-resizing-task-panes");
      if (pane.handle.hasPointerCapture(pointerId)) pane.handle.releasePointerCapture(pointerId);
      persist();
    };
    pane.handle.addEventListener("pointerup", finish);
    pane.handle.addEventListener("pointercancel", finish);
    pane.handle.addEventListener("lostpointercapture", finish);
    pane.handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = Number(pane.handle.getAttribute("aria-valuenow"));
      const step = event.shiftKey ? 32 : 16;
      resize(event.key === "Home" ? pane.minimum : event.key === "End" ? pane.maximum() : current + (event.key === "ArrowRight" ? step : -step));
      persist();
    });
  }
  new ResizeObserver(sync).observe(workbench);
  window.addEventListener("resize", sync);
  sync();
}
