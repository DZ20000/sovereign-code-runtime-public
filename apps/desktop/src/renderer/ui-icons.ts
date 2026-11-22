export type UiIcon = "home" | "tasks" | "approval" | "settings" | "chevron" | "copy" | "code" | "close" | "terminal" | "python" | "browser" | "computer" | "workflows";

/** Approved vector assets keep their intrinsic 20px geometry; CSS supplies theme color. */
export function renderUiIcon(name: UiIcon): string {
  return `<span class="v2-icon v2-icon-${name}" aria-hidden="true"></span>`;
}
