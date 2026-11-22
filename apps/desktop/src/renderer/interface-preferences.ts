import type { UiLanguage } from "./localization.js";
import type { ExperienceMode, StartupViewPreference } from "./navigation-state.js";
import type { UiTheme } from "./ui-theme.js";

export type UiScale = 1 | 1.1 | 1.25 | 1.5;
export type UiFontScale = 1 | 1.1 | 1.2 | 1.3;
export interface UiSettings {
  readonly sidebarCollapsed: boolean;
  readonly startupView: StartupViewPreference;
  readonly refreshIntervalMs: 1000 | 3000 | 5000 | 10000;
  readonly reducedMotion: boolean;
  readonly uiScale: UiScale;
  readonly fontScale: UiFontScale;
  readonly language: UiLanguage;
  readonly experienceMode: ExperienceMode;
  readonly theme: UiTheme;
}
export function defaultUiSettings(language: string): UiSettings {
  return { sidebarCollapsed: false, startupView: "overview", refreshIntervalMs: 5000,
    reducedMotion: false, uiScale: 1, fontScale: 1,
    language: language.toLowerCase().startsWith("zh") ? "zh-CN" : "en",
    experienceMode: "simple", theme: "system" };
}
export function normalizeUiSettings(value: unknown, defaults: UiSettings): UiSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
  const p = value as Partial<UiSettings>;
  return {
    sidebarCollapsed: p.sidebarCollapsed === true,
    startupView: p.startupView === "tasks" || p.startupView === "runs" ? "tasks" : p.startupView === "last" ? "last" : "overview",
    refreshIntervalMs: [1000, 3000, 5000, 10000].includes(p.refreshIntervalMs ?? 0) ? p.refreshIntervalMs! : defaults.refreshIntervalMs,
    reducedMotion: p.reducedMotion === true,
    uiScale: [1, 1.1, 1.25, 1.5].includes(p.uiScale ?? 0) ? p.uiScale! : defaults.uiScale,
    fontScale: [1, 1.1, 1.2, 1.3].includes(p.fontScale ?? 0) ? p.fontScale! : defaults.fontScale,
    language: p.language === "en" || p.language === "zh-CN" ? p.language : defaults.language,
    experienceMode: p.experienceMode === "full" || p.experienceMode === "simple" ? p.experienceMode : defaults.experienceMode,
    theme: p.theme === "light" || p.theme === "dark" || p.theme === "system" ? p.theme : defaults.theme,
  };
}
