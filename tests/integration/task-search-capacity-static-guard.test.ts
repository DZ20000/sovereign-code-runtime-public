import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("task search capacity guard", () => {
  it("uses the session capacity policy for both live normalization and the input", () => {
    const session = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-hub-session.ts",
    );
    const filter = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-filter-controls.ts",
    );
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    expect(session).toContain(
      "export const TASK_HUB_SESSION_MAX_SEARCH_LENGTH = 256;",
    );
    expect(filter).toContain(".slice(0, TASK_HUB_SESSION_MAX_SEARCH_LENGTH)");
    expect(view).toContain('maxlength="${TASK_HUB_SESSION_MAX_SEARCH_LENGTH}"');
  });
});
