import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { taskWaitingMessageLabel } from "../src/renderer/task-board-model.js";

describe("task waiting message label", () => {
  it("omits empty state and pluralizes pending user messages", () => {
    expect(taskWaitingMessageLabel({ unreadUserMessageCount: 0 })).toBeNull();
    expect(taskWaitingMessageLabel({ unreadUserMessageCount: 1 })).toBe(
      "1 waiting message",
    );
    expect(taskWaitingMessageLabel({ unreadUserMessageCount: 3 })).toBe(
      "3 waiting messages",
    );
  });

  it("wires the shared label into the rendered task card", () => {
    const controller = readFileSync(
      resolve(
        process.cwd(),
        "apps",
        "desktop",
        "src",
        "renderer",
        "tasks-controller.ts",
      ),
      "utf8",
    );
    expect(controller).toContain(
      "const waitingMessageLabel = taskWaitingMessageLabel(task);",
    );
    expect(controller).toContain("unread.textContent = waitingMessageLabel;");
  });
});
