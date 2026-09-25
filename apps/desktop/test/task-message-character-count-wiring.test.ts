import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("task message character count wiring", () => {
  it("keeps the counter, submit eligibility and restored drafts synchronized", () => {
    const controller = source("apps/desktop/src/renderer/tasks-controller.ts");
    const view = source("apps/desktop/src/renderer/view-tasks.ts");
    const styles = source("apps/desktop/src/renderer/task-hub.css");
    const localization = source(
      "apps/desktop/src/renderer/task-board-localization.ts",
    );

    expect(view).toContain('id="task-message-character-count"');
    expect(view).toContain(
      'aria-describedby="task-message-help task-message-shortcuts task-message-character-count task-message-submit-status"',
    );
    expect(view).toContain(
      'id="task-message-send" class="button button-primary" type="submit" aria-describedby="task-message-submit-status" disabled',
    );
    expect(controller).toContain(
      'counter: requiredElement<HTMLElement>("#task-message-character-count")',
    );
    expect(
      controller.match(/this\.#messageSendFeedback\?\.syncDraft\(\)/gu)
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(styles).toContain(".task-message-character-count");
    expect(styles).toContain("font-variant-numeric: tabular-nums");
    expect(localization).toContain(
      "match = value.match(/^(\\d+) of (\\d+) characters$/u)",
    );
  });
});
