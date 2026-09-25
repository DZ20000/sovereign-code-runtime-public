import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const controller = readFileSync(
  join(
    process.cwd(),
    "apps",
    "desktop",
    "src",
    "renderer",
    "tasks-controller.ts",
  ),
  "utf8",
);

describe("task detail request cancellation static guards", () => {
  it("invalidates pending detail reads before returning to the task list", () => {
    const showProjects = controller.match(
      /showProjects\(\): void \{[\s\S]*?\n  #restoreListFocus\(/u,
    )?.[0];
    expect(showProjects).toBeDefined();
    expect(showProjects).toContain("this.#storeCurrentDraft()");
    expect(showProjects).toContain("this.#detailRequestGeneration += 1");
  });

  it("drops stale success and failure results after the request generation changes", () => {
    const loadDetail = controller.match(
      /async #loadDetail\([\s\S]*?\n  #storeCurrentDraft\(/u,
    )?.[0];
    expect(loadDetail).toBeDefined();
    expect(loadDetail).toContain(
      "const generation = ++this.#detailRequestGeneration",
    );
    expect(
      loadDetail?.match(/generation !== this\.#detailRequestGeneration/gu),
    ).toHaveLength(2);
  });
});
