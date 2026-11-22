import { describe, expect, it } from "vitest";
import { normalizeSettingsTab, renderSettingsView } from "../src/renderer/view-settings.js";

function pane(markup: string, name: string): string {
  const start = markup.indexOf(`<section id="settings-pane-${name}"`);
  const end = markup.indexOf('<section id="settings-pane-', start + 1);
  return markup.slice(start, end < 0 ? markup.length : end);
}

describe("three settings groups", () => {
  it("keeps old Host destinations in General and accepts only the three groups", () => {
    for (const value of ["host", "appearance", "", null, undefined, "unknown"]) {
      expect(normalizeSettingsTab(value)).toBe("appearance");
    }
    expect(normalizeSettingsTab("security")).toBe("security");
    expect(normalizeSettingsTab("diagnostics")).toBe("diagnostics");
  });

  it("has one workspace form and preserves existing startup, permission and diagnostic controls", () => {
    const markup = renderSettingsView();
    expect([...markup.matchAll(/data-settings-tab="([^"]+)"/gu)].map((match) => match[1]))
      .toEqual(["appearance", "security", "diagnostics"]);
    const ids = [...markup.matchAll(/ id="([^"]+)"/gu)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(50);
    expect(new Set(ids).size).toBe(ids.length);
    const general = pane(markup, "appearance");
    const workspace = pane(markup, "security");
    const advanced = pane(markup, "diagnostics");
    for (const id of ["ui-language", "pref-theme", "ui-experience-mode", "ui-startup-view", "ui-scale",
      "ui-font-scale", "ui-reduced-motion", "sidebar-collapsed-setting", "host-launch-at-login",
      "auto-start-runtime", "unattended-workspace-access", "tunnel-auto-start", "tunnel-auto-reconnect",
      "remote-host-enable", "host-guardian-state", "host-availability-state", "v2-save-preferences"]) {
      expect(general).toContain(`id="${id}"`);
    }
    for (const id of ["workspace-page-path", "workspace-page-choose", "settings-permission-profiles",
      "settings-bypass-toggle", "settings-workspace-protection", "capability-list", "manifest-groups",
      "restart-authority-value", "v2-save-workspace"]) {
      expect(workspace).toContain(`id="${id}"`);
      expect(general).not.toContain(`id="${id}"`);
      expect(advanced).not.toContain(`id="${id}"`);
    }
    for (const id of ["ui-refresh-interval", "renderer-update-install", "renderer-update-preflight",
      "renderer-update-activate", "renderer-update-rollback", "runtime-candidate-install",
      "runtime-candidate-activate", "runtime-rolling-refresh", "availability-event-list",
      "resources-refresh", "resources-process-list", "settings-connection-advanced", "v2-refresh-diagnostics"]) {
      expect(advanced).toContain(`id="${id}"`);
    }
    expect(workspace).toContain("Other actions remain subject to their own permissions and approvals.");
    expect(advanced).toContain('data-settings-target="security"');
  });
});
