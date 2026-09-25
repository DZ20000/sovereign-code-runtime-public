import { describe, expect, it } from "vitest";

import {
  isTaskMessageSubmitShortcut,
  TASK_MESSAGE_MAX_LENGTH,
  TaskMessageSendFeedback,
  taskMessageCanSubmit,
  taskMessageCharacterCount,
  taskMessageContent,
} from "../src/renderer/task-message-composer.js";

class FakeElement {
  disabled = false;
  value = "Draft";
  textContent: string | null = null;
  focusCount = 0;
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(): void {
    this.focusCount += 1;
  }
}

function composerFixture(): {
  readonly form: FakeElement;
  readonly input: FakeElement;
  readonly button: FakeElement;
  readonly status: FakeElement;
  readonly counter: FakeElement;
  readonly feedback: TaskMessageSendFeedback;
} {
  const form = new FakeElement();
  const input = new FakeElement();
  const button = new FakeElement();
  button.textContent = "Send message";
  const status = new FakeElement();
  status.textContent = "";
  const counter = new FakeElement();
  const feedback = new TaskMessageSendFeedback({
    form,
    input,
    button,
    status,
    counter,
  });
  return { form, input, button, status, counter, feedback };
}

describe("task message composer", () => {
  it("normalizes content and enforces the registry length boundary", () => {
    expect(taskMessageContent("  Keep validating.  ")).toBe("Keep validating.");
    expect(taskMessageContent("   ")).toBeNull();
    expect(
      taskMessageContent("x".repeat(TASK_MESSAGE_MAX_LENGTH)),
    ).toHaveLength(TASK_MESSAGE_MAX_LENGTH);
    expect(() =>
      taskMessageContent("x".repeat(TASK_MESSAGE_MAX_LENGTH + 1)),
    ).toThrow("cannot exceed 8000 characters");
  });

  it("derives submit eligibility and a stable character count", () => {
    expect(taskMessageCanSubmit("")).toBe(false);
    expect(taskMessageCanSubmit("   ")).toBe(false);
    expect(taskMessageCanSubmit("Continue")).toBe(true);
    expect(taskMessageCanSubmit("x".repeat(TASK_MESSAGE_MAX_LENGTH + 1))).toBe(
      false,
    );
    expect(taskMessageCharacterCount("abcd")).toBe("4 / 8000");
  });

  describe.each([
    { shortcut: "Enter", ctrlKey: false, metaKey: false },
    { shortcut: "Ctrl+Enter", ctrlKey: true, metaKey: false },
    { shortcut: "Command+Enter", ctrlKey: false, metaKey: true },
  ])("$shortcut", ({ ctrlKey, metaKey }) => {
    const event = {
      key: "Enter",
      ctrlKey,
      metaKey,
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    };

    it("submits the draft", () => {
      expect(isTaskMessageSubmitShortcut(event)).toBe(true);
    });

    it("leaves Shift+Enter to insert a newline", () => {
      expect(isTaskMessageSubmitShortcut({ ...event, shiftKey: true })).toBe(false);
    });

    it("does not submit while confirming an IME candidate", () => {
      expect(isTaskMessageSubmitShortcut({ ...event, isComposing: true })).toBe(false);
    });

    it("does not submit an IME processing key after isComposing clears", () => {
      expect(isTaskMessageSubmitShortcut({ ...event, keyCode: 229 })).toBe(false);
    });
  });

  it.each(["Escape", "a", " ", "Process"])("does not submit for %j", (key) => {
    expect(isTaskMessageSubmitShortcut({
      key,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
    })).toBe(false);
  });

  it("synchronizes the counter and disables blank drafts", () => {
    const { input, button, counter, feedback } = composerFixture();
    expect(button.disabled).toBe(false);
    expect(counter.textContent).toBe("5 / 8000");
    expect(counter.attributes.get("aria-label")).toBe("5 of 8000 characters");

    input.value = "   ";
    feedback.syncDraft();
    expect(button.disabled).toBe(true);
    expect(counter.textContent).toBe("3 / 8000");
  });

  it("locks editing during send and restores a failed shortcut draft", () => {
    const { form, input, button, status, feedback } = composerFixture();
    feedback.begin("input");
    expect(form.attributes.get("aria-busy")).toBe("true");
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Sending…");

    feedback.fail(true);
    feedback.end(true);
    expect(input.value).toBe("Draft");
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(status.textContent).toBe("Message not sent. Draft preserved.");
    expect(input.focusCount).toBe(1);
  });

  it("marks an uncertain delivery without clearing the preserved draft", () => {
    const { input, status, feedback } = composerFixture();
    feedback.begin("input");
    feedback.fail(true, true);
    feedback.end(true);
    expect(input.value).toBe("Draft");
    expect(status.textContent).toBe("Delivery uncertain. Draft preserved.");
    expect(input.focusCount).toBe(1);
  });

  it("clears a successful draft and returns to a disabled empty state", () => {
    const { input, button, status, feedback } = composerFixture();
    feedback.begin("button");
    feedback.succeed(true);
    feedback.end(true);
    expect(input.value).toBe("");
    expect(button.disabled).toBe(true);
    expect(status.textContent).toBe("Message saved.");
    expect(button.focusCount).toBe(1);
  });

  it("does not clear, announce or steal focus after navigation", () => {
    const { input, button, status, feedback } = composerFixture();
    feedback.begin("input");
    feedback.succeed(false);
    feedback.end(false);
    expect(input.value).toBe("Draft");
    expect(status.textContent).toBe("");
    expect(input.focusCount).toBe(0);
    expect(button.focusCount).toBe(0);
  });
  it("restores the button label from the current locale on every send", () => {
    const form = new FakeElement();
    const input = new FakeElement();
    const button = new FakeElement();
    const status = new FakeElement();
    const counter = new FakeElement();
    const feedback = new TaskMessageSendFeedback({
      form,
      input,
      button,
      status,
      counter,
    });

    button.textContent = "发送消息";
    feedback.begin("button");
    expect(button.textContent).toBe("Sending…");
    feedback.succeed(true);
    feedback.end(true);
    expect(button.textContent).toBe("发送消息");
  });
});
