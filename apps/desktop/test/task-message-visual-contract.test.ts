import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
describe("task message visual contract", () => {
  it("preserves authored line breaks and wraps unbroken content", () => {
    const styles = readFileSync(
      resolve(
        process.cwd(),
        "apps",
        "desktop",
        "src",
        "renderer",
        "task-hub.css",
      ),
      "utf8",
    );
    const rule = styles.match(/\.task-message-content\s*\{[^}]+\}/u)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("overflow-wrap: anywhere");
  });
});
