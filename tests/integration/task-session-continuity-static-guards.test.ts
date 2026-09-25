import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("Task web session continuity static guards", () => {
  it("renders a dedicated bounded continuity card in Task detail", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    for (const id of [
      "task-session-continuity",
      "task-session-continuity-state",
      "task-session-continuity-owner",
      "task-session-continuity-conversation",
      "task-session-continuity-next",
    ]) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(view).toContain('data-no-i18n=""');
  });

  it("restores bounded filters, selection and message drafts without blocking Tasks", () => {
    const session = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-hub-session.ts",
    );
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    expect(session).toContain(
      'TASK_HUB_SESSION_KEY = "sovereign.ui.task-hub-session.v1"',
    );
    expect(session).toContain("const MAX_DRAFTS = 32");
    expect(session).toContain("const MAX_DRAFT_LENGTH = 8_000");
    expect(session).toContain("const MAX_DRAFT_TOTAL_LENGTH = 128_000");
    expect(session).toContain("const MAX_TASK_ID_LENGTH = 128");
    expect(session).toContain("UNSAFE_RECORD_KEYS");
    expect(session).toContain("Renderer-session UI state is best-effort");
    expect(controller).toContain("taskHubSessionStorage(): Storage | null");
    expect(controller).toContain(
      "readTaskHubSessionState(this.#sessionStorage)",
    );
    expect(controller).toContain(
      "writeTaskHubSessionState(this.#sessionStorage",
    );
    expect(controller).toContain("#restoreSelectedTaskOnRefresh");
    expect(controller).toContain("rerenderSelectedDetail(): void");
    expect(controller).toContain(
      "const activeElement = document.activeElement",
    );
    expect(controller).toContain("activeElement === input");
  });

  it("states the browser-memory limitation and exposes no opaque session identity", () => {
    const model = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-session-continuity.ts",
    );
    expect(model).toContain("Browser memory is not copied");
    expect(model).toContain("不会自动复制浏览器对话记忆");
    expect(model).not.toMatch(
      /sessionKeyDigestPrefix|sessionId|openai\/session/iu,
    );
  });

  it("keeps the view idempotent and isolated from the shared UI refinement layer", () => {
    const renderer = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-session-continuity-view.ts",
    );
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    expect(renderer).toContain("if (element.textContent !== value)");
    expect(renderer).toContain("if (root.className !== className)");
    expect(main).toContain('import "./task-session-continuity.css"');
  });

  it("keeps the new modules within a reviewable size", () => {
    for (const file of [
      "task-hub-session.ts",
      "task-session-continuity.ts",
      "task-session-continuity-view.ts",
    ]) {
      const lineCount = source(
        "apps",
        "desktop",
        "src",
        "renderer",
        file,
      ).split(/\r?\n/u).length;
      expect(lineCount, file).toBeLessThan(360);
    }
  });
});
