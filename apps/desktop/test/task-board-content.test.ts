import { describe, expect, it } from "vitest";

import { BOARD_LANE_CONTENT } from "../src/renderer/task-board-content.js";
import type { TaskBoardLane } from "../src/renderer/task-board-model.js";

const TASK_BOARD_LANES = [
  "current",
  "attention",
  "history",
  "activity",
  "all",
] as const satisfies readonly TaskBoardLane[];

describe("task board lane content", () => {
  it("defines bounded operator copy for every trusted task lane", () => {
    expect(Object.keys(BOARD_LANE_CONTENT).sort()).toEqual(
      [...TASK_BOARD_LANES].sort(),
    );
    for (const lane of TASK_BOARD_LANES) {
      const content = BOARD_LANE_CONTENT[lane];
      expect(content.title.trim().length).toBeGreaterThan(0);
      expect(content.description.trim().length).toBeGreaterThan(0);
      expect(content.emptyTitle.trim().length).toBeGreaterThan(0);
      expect(content.emptyDetail.trim().length).toBeGreaterThan(0);
      expect(content.visibleLabel.trim().length).toBeGreaterThan(0);
      expect(content.description.length).toBeLessThanOrEqual(180);
      expect(content.emptyDetail.length).toBeLessThanOrEqual(180);
    }
  });
});
