export interface TaskDetailNavigationEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

function editableTaskDetailTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("matches" in target)) {
    return false;
  }
  const matches = (target as { readonly matches?: unknown }).matches;
  if (typeof matches !== "function") return false;
  return (
    matches.call(
      target,
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ) === true
  );
}

export function taskDetailBackShortcutRequested(
  event: Pick<
    TaskDetailNavigationEvent,
    | "key"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
    | "defaultPrevented"
    | "target"
  >,
): boolean {
  if (event.defaultPrevented || editableTaskDetailTarget(event.target)) {
    return false;
  }
  if (
    event.key === "Escape" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return true;
  }
  return (
    event.key === "ArrowLeft" &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

export function bindTaskDetailKeyboardNavigation(
  pane: HTMLElement,
  onBack: () => void,
): void {
  pane.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pane.querySelector(":popover-open") !== null) return;
    if (!taskDetailBackShortcutRequested(event)) return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  });
}
