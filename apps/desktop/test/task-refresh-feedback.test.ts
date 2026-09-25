import { describe, expect, it } from "vitest";

import {
  TaskRefreshFeedback,
  taskRefreshSuccessMessage,
  taskRefreshUnavailableMessage,
} from "../src/renderer/task-refresh-feedback.js";

class FakeElement {
  disabled = false;
  readonly attributes = new Map<string, string>();
  textWrites = 0;
  #textContent: string | null = null;

  get textContent(): string | null {
    return this.#textContent;
  }

  set textContent(value: string | null) {
    this.textWrites += 1;
    this.#textContent = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

function fixture(): {
  readonly button: FakeElement;
  readonly region: FakeElement;
  readonly status: FakeElement;
  readonly syncStatus: FakeElement;
  readonly feedback: TaskRefreshFeedback;
} {
  const button = new FakeElement();
  const region = new FakeElement();
  const status = new FakeElement();
  const syncStatus = new FakeElement();
  return {
    button,
    region,
    status,
    syncStatus,
    feedback: new TaskRefreshFeedback({
      button,
      busyRegion: region,
      status,
      syncStatus,
    }),
  };
}

describe("task refresh feedback", () => {
  it("formats changed, unchanged and unavailable results", () => {
    expect(
      taskRefreshSuccessMessage(7, { revision: 7, totalTaskCount: 12 }),
    ).toBe("Task board refreshed. No changes.");
    expect(
      taskRefreshSuccessMessage(7, { revision: 8, totalTaskCount: 1 }),
    ).toBe("Task board refreshed. 1 record loaded.");
    expect(
      taskRefreshSuccessMessage(null, { revision: 1, totalTaskCount: 0 }),
    ).toBe("Task board refreshed. 0 records loaded.");
    expect(taskRefreshUnavailableMessage(true)).toContain(
      "last successful snapshot",
    );
    expect(taskRefreshUnavailableMessage(false)).toContain(
      "No successful snapshot",
    );
  });

  it("tracks the manual busy lifecycle and final result", () => {
    const { button, region, status, feedback } = fixture();

    feedback.begin();
    expect(button.disabled).toBe(true);
    expect(button.attributes.get("aria-busy")).toBe("true");
    expect(region.attributes.get("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Refreshing task board…");

    feedback.succeed(3, { revision: 4, totalTaskCount: 9 });
    feedback.end();
    expect(button.disabled).toBe(false);
    expect(button.attributes.has("aria-busy")).toBe(false);
    expect(region.attributes.has("aria-busy")).toBe(false);
    expect(status.textContent).toBe("Task board refreshed. 9 records loaded.");
  });

  it("announces a manual failure and visibly preserves the old snapshot", () => {
    const { button, region, status, syncStatus, feedback } = fixture();

    feedback.begin();
    feedback.manualFail(true);
    feedback.end();

    expect(button.disabled).toBe(false);
    expect(region.attributes.has("aria-busy")).toBe(false);
    expect(status.textContent).toBe(
      "Task board refresh failed. Existing task data was not replaced.",
    );
    expect(syncStatus.textContent).toBe(
      "Task board unavailable. Showing the last successful snapshot.",
    );
  });

  it("keeps the unavailable state visible until a successful snapshot arrives", () => {
    const { syncStatus, feedback } = fixture();

    feedback.backgroundFail(true);
    feedback.sync("4 records · refreshed just now");
    expect(syncStatus.textContent).toContain("last successful snapshot");

    feedback.markAvailable();
    feedback.sync("4 records · refreshed just now");
    expect(syncStatus.textContent).toBe("4 records · refreshed just now");
  });

  it("does not repeatedly mutate the live status during background failures", () => {
    const { status, syncStatus, feedback } = fixture();

    feedback.backgroundFail(false);
    syncStatus.textContent = "任务面板暂不可用";
    const writesAfterLocalization = syncStatus.textWrites;
    feedback.backgroundFail(false);

    expect(status.textWrites).toBe(0);
    expect(syncStatus.textWrites).toBe(writesAfterLocalization);
    expect(syncStatus.textContent).toBe("任务面板暂不可用");
  });
});
