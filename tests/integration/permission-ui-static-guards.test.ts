import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("permission level UI static guards", () => {
  it("renders one four-level permission selector without duplicate bypass panels", () => {
    const renderer = source("apps", "desktop", "src", "renderer", "main.ts");
    const settings = source("apps", "desktop", "src", "renderer", "view-settings.ts");
    const agent = source("apps", "desktop", "src", "renderer", "view-agent.ts");
    const legacyStyles = source("apps", "desktop", "src", "renderer", "workbench.css");
    const refinementStyles = source("apps", "desktop", "src", "renderer", "ui-refinement.css");

    expect(renderer).toContain('const selected = button.dataset.permissionProfile === activeProfile;');
    expect(renderer).toMatch(
      /document\.querySelectorAll<HTMLButtonElement>\(\s*"\[data-permission-bypass\]"\s*,?\s*\)/u,
    );
    expect(renderer).toContain('button.classList.toggle("is-selected", bypassActive)');
    expect(renderer).toContain('renderPermissionChoiceState(state)');
    expect(renderer).not.toContain('button.dataset.permissionFallback = "true"');
    expect(renderer).not.toContain("displayedPermissionProfile");
    expect(renderer).not.toContain("is-overridden");
    expect(settings).toContain("This startup setting does not change the selected permission.");
    expect(settings).not.toContain("Enabling from L1 raises it to L2");
    expect(renderer).toContain("Permission unchanged · workspace restored after sign-in");

    expect(settings).toContain('class="permission-segment settings-permission-segment"');
    expect(settings).toContain('id="settings-bypass-toggle"');
    expect(settings).toContain('data-permission-bypass');
    expect(settings).not.toContain('id="settings-bypass-section"');
    expect(settings).not.toContain('id="settings-bypass-row"');
    expect(settings).not.toContain('id="settings-permission-fallback"');
    expect(agent).toContain('class="permission-segment"');
    expect(agent).toContain('id="web-bypass-toggle"');
    expect(agent).not.toContain('id="web-bypass-panel"');
    expect(agent).not.toContain('id="web-permission-fallback"');
    expect(agent).not.toContain("L4 is the only active permission.");
    expect(settings).not.toContain("L4 is the only active permission.");

    const permissionLayout =
      [legacyStyles, refinementStyles].join("\n").match(/\.permission-segment\b[^{]*\{[^}]*\}/gu) ?? [];
    expect(permissionLayout.length).toBeGreaterThan(0);
    expect(permissionLayout.join("\n")).toContain("grid-template-columns");
    expect([legacyStyles, refinementStyles].join("\n")).toMatch(
      /\.permission-bypass-option(?:\.is-selected|\[aria-pressed="true"\])/u,
    );
    expect(legacyStyles).toContain('[data-permission-profile="consequential"].is-selected');
    expect(legacyStyles).not.toContain(".is-selected.is-overridden");
  });

  it("keeps workspace restore independent from permission in operator documentation", () => {
    const readme = source("README.md");
    const architecture = source("docs", "architecture.md");
    const remoteHost = source("docs", "remote-host.md");
    const combined = `${readme}
${architecture}
${remoteHost}`;

    expect(combined).not.toContain("Enabling unattended access from L1 raises");
    expect(combined).not.toContain("Enabling unattended access while L1 is selected promotes");
    expect(combined).not.toContain("Choosing L1 revokes unattended access");
    expect(combined).not.toContain("Choosing L1 explicitly always revokes unattended access");
    expect(readme).toContain("enabling or disabling it never changes the active L1-L4 permission");
    expect(architecture).toContain("Workspace restore is persisted separately and never promotes");
    expect(remoteHost).toContain("Workspace restore and permission are independent settings");
  });

  it("keeps active advanced permissions and the L4 selector visible in simple mode", () => {
    const legacyStyles = source("apps", "desktop", "src", "renderer", "workbench.css");
    const refinementStyles = source("apps", "desktop", "src", "renderer", "ui-refinement.css");
    expect(legacyStyles).toMatch(
      /html\[data-experience-mode="simple"\] \[data-permission-profile="consequential"\]\.is-selected \{[\s\S]*?display:\s*(?!none)[a-z-]+\s*!important;/u,
    );
    expect(refinementStyles).toMatch(
      /html\[data-experience-mode="simple"\] \[data-permission-bypass\] \{[\s\S]*?display:\s*(?!none)[a-z-]+\s*!important;/u,
    );
  });
});
