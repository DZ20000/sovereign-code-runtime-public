export type UiTheme = "system" | "light" | "dark";
export function resolvedTheme(theme: UiTheme): "light" | "dark" {
  return theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme;
}
export function applyTheme(theme: UiTheme): void {
  document.documentElement.dataset.theme = resolvedTheme(theme);
  document.documentElement.style.colorScheme = resolvedTheme(theme);
  const select = document.querySelector<HTMLSelectElement>("#pref-theme");
  if (select) select.value = theme;
}
