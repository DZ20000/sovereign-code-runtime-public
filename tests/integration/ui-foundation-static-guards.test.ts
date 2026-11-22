import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(process.cwd(), "apps/desktop/src/renderer");
const source = (name: string) => readFileSync(resolve(root, name), "utf8");

describe("v2 layout foundation", () => {
  it("has four core routes and one folded developer group", () => {
    const registry = source("view-registry.ts");
    expect([...registry.matchAll(/id: "([^"]+)"[^\n]+navigationSection: "primary"/gu)].map(match => match[1])).toEqual(["overview", "tasks", "approvals", "settings"]);
    const shell = source("shell.ts");
    expect(shell).toContain('id="execute-group-toggle"');
    expect(shell).toContain('aria-expanded="false"');
    expect(shell).toContain('id="execute-group" class="navigation-group-items" hidden');
    expect(shell).not.toContain("statusbar");
  });
  it("uses bounded widths, single-line navigation and one compact Overview", () => {
    const styles = source("v2.css");
    expect(source("tokens.css")).toContain("--ui-sidebar-width: 232px");
    expect(styles).toMatch(/\.navigation-label\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/u);
    expect(styles).toMatch(/\.v2-drawer-heading h2\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/u);
    expect(styles).toContain('data-experience-mode="simple"');
    expect(source("view-overview.ts")).not.toContain("simple-overview");
  });
  it("gives dark primary and secondary actions separate contrast treatments", () => {
    const tokens = source("tokens.css");
    expect(tokens).toContain('--color-accent: #b0bdff');
    expect(tokens).toContain('--color-on-accent: #171e3b');
    const styles = source("v2.css");
    expect(styles).toMatch(/\.button-primary\s*\{[^}]*color: var\(--color-on-accent\)[^}]*background: var\(--color-accent\)/u);
    expect(styles).toMatch(/\.button-secondary\s*\{[^}]*background: var\(--color-hover\)[^}]*border-color:/u);
  });
});
