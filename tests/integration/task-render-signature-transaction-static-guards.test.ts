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

describe("task render signature transaction static guards", () => {
  it("commits the message signature only after reconciliation succeeds", () => {
    const block = controller.match(
      /if \(signature !== this\.#renderedMessagesSignature\) \{[\s\S]*?\n    \}/u,
    )?.[0];
    expect(block).toBeDefined();
    const reconcileIndex = block?.indexOf("reconcileTaskMessageList") ?? -1;
    const commitIndex =
      block?.indexOf("this.#renderedMessagesSignature = signature") ?? -1;
    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(reconcileIndex);
  });
});
