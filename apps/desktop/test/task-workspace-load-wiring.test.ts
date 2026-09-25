import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("task workspace load failure wiring", () => {
  it("renders an explicit unavailable state only when no trusted snapshot exists", () => {
    const controller = source("apps/desktop/src/renderer/tasks-controller.ts");

    expect(controller).toContain("#workspaceLoadError: string | null = null");
    expect(controller).toContain("this.#workspaceLoadError = null");
    expect(controller).toContain("if (this.#snapshot === null)");
    expect(controller).toContain("this.#workspaceLoadError = message");
    expect(controller).toContain(
      "const presentation = taskWorkspaceLoadPresentation(",
    );
    expect(controller).toContain("this.#workspaceLoadError,");
    expect(controller).toContain(
      'empty.setAttribute("role", presentation.liveRole)',
    );
    expect(controller).toContain('presentation.kind === "unavailable"');
    expect(controller).toContain("loading || unavailable");
  });
});
