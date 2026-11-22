import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(process.cwd(), "apps/desktop/src/renderer");
const source = (name: string) => readFileSync(resolve(root, name), "utf8");

describe("shared renderer style system", () => {
  it("ships only tokens and component styles with no patch cascade", () => {
    expect(readdirSync(root).filter(name => name.endsWith(".css")).sort()).toEqual(["tokens.css", "v2.css"]);
    expect([...source("main.ts").matchAll(/import "(.+\.css)";/gu)].map(match => match[1])).toEqual(["./tokens.css", "./v2.css"]);
    expect(source("approval.html")).toContain('href="./tokens.css"');
    expect(source("approval.html")).toContain('href="./v2.css"');
  });
  it("shares semantic colors across the shell, controls, workbenches and approvals", () => {
    const tokens = source("tokens.css");
    for (const name of ["canvas", "sidebar", "surface", "elevated", "inset", "hover", "divider", "text", "secondary", "muted", "accent", "on-accent", "success", "warning", "danger", "focus"]) {
      expect(tokens.match(new RegExp("--color-" + name + ":", "gu"))).toHaveLength(2);
    }
    const styles = source("v2.css");
    for (const selector of [".v2-connection-card", ".v2-tasks .task-summary-card", ".v2-settings", ".v2-approval-dialog", ".cm-editor"]) expect(styles).toContain(selector);
    expect(styles).not.toMatch(/@import/u);
  });
  it("keeps keyboard focus explicit and receipts distinguishable", () => {
    const styles = source("v2.css");
    expect(styles).toMatch(/:focus-visible\s*\{\s*outline: 2px solid var\(--color-focus\)/u);
    expect(styles).toContain("task-message-delivery-acknowledged");
    expect(styles).toContain("task-message-delivery-pending");
    expect(styles).toContain("prefers-reduced-motion: reduce");
  });
});
