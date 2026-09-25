import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("task detail identity static guards", () => {
  it("binds both detail-read and message-send responses to the full requested-task integrity contract", () => {
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    expect(
      controller.match(/assertTaskDetailIntegrity\(taskId, detail\);/gu),
    ).toHaveLength(2);
    expect(controller).toContain("isTaskDetailIntegrityError(error)");
  });
});
