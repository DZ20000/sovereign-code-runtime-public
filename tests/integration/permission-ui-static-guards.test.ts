import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(process.cwd(), "apps/desktop/src/renderer");
const source = (name: string) => readFileSync(resolve(root, name), "utf8");

describe("workspace permission UI boundaries", () => {
  it("has one four-level selector in Settings and an explicit Apply action", () => {
    const settings = source("view-settings.ts");
    expect((settings.match(/data-permission-profile=/gu) ?? []).length).toBe(3);
    expect(settings).toContain('id="settings-bypass-toggle"');
    expect(settings).toContain('id="v2-save-workspace"');
    expect(source("view-agent.ts")).not.toContain("data-permission-profile");
    expect(source("view-tasks.ts")).not.toContain("data-permission-profile");
    expect(source("main.ts")).toContain("permissionDraft = profile;");
    expect(source("main.ts")).toContain('setPermissionProfile(profile, scope ?? undefined)');
  });
  it("keeps project permission scope explicit and fails closed after it becomes inactive", () => {
    const main = source("main.ts");
    expect(main).toContain('state.activeDesktopWorkspace?.id === permissionScopeId');
    expect(main).toContain('state.activeDesktopWorkspace?.id !== workspaceId');
    expect(main).toContain('context === null');
    expect(main).toContain('permissionSaving || context === null || context.root === null');
    expect(main).not.toContain('setPermissionProfile(profile, "desktop-workspace")');
    expect(main).toContain('state.activeDesktopWorkspace.permissionProfile');
    const projectPermissionButton = source("view-tasks.ts").match(/<button\b[^>]*id="task-project-workspace-permissions"[^>]*>/u)?.[0];
    expect(projectPermissionButton).toBeDefined();
    expect(projectPermissionButton).not.toMatch(/data-(?:open-view|settings-target)=/u);
  });
  it("does not couple unattended workspace restore to elevation", () => {
    const settings = source("view-settings.ts");
    expect(settings).toContain("This startup setting does not change the selected permission.");
    for (const name of ["README.md", "docs/architecture.md", "docs/remote-host.md"]) {
      const text = readFileSync(resolve(process.cwd(), name), "utf8");
      expect(text).not.toContain("Enabling unattended access from L1 raises");
      expect(text).not.toContain("Choosing L1 revokes unattended access");
    }
  });
});
