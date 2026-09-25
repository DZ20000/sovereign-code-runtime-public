export const TASK_MESSAGE_MAX_LENGTH = 8_000;

interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface ComposerInput extends AttributeTarget {
  disabled: boolean;
  value: string;
  focus(options?: FocusOptions): void;
}

interface ComposerButton extends AttributeTarget {
  disabled: boolean;
  textContent: string | null;
  focus(options?: FocusOptions): void;
}

interface ComposerText {
  textContent: string | null;
}

interface ComposerCounter extends AttributeTarget, ComposerText {}

export interface TaskMessageSendFeedbackOptions {
  readonly form: AttributeTarget;
  readonly input: ComposerInput;
  readonly button: ComposerButton;
  readonly status: ComposerText;
  readonly counter: ComposerCounter;
}

export type TaskMessageFocusTarget = "button" | "input" | null;

export interface TaskMessageShortcutEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode?: number;
}

export function taskMessageContent(value: string): string | null {
  const content = value.trim();
  if (content.length === 0) return null;
  if (content.length > TASK_MESSAGE_MAX_LENGTH) {
    throw new Error(
      `Task messages cannot exceed ${TASK_MESSAGE_MAX_LENGTH} characters.`,
    );
  }
  return content;
}

export function taskMessageCanSubmit(value: string): boolean {
  try {
    return taskMessageContent(value) !== null;
  } catch {
    return false;
  }
}

export function taskMessageCharacterCount(value: string): string {
  return `${value.length} / ${TASK_MESSAGE_MAX_LENGTH}`;
}

export function isTaskMessageSubmitShortcut(
  event: TaskMessageShortcutEvent,
): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

export class TaskMessageSendFeedback {
  readonly #form: AttributeTarget;
  readonly #input: ComposerInput;
  readonly #button: ComposerButton;
  readonly #status: ComposerText;
  readonly #counter: ComposerCounter;
  #idleButtonText: string;
  #focusTarget: TaskMessageFocusTarget = null;
  #sending = false;

  constructor(options: TaskMessageSendFeedbackOptions) {
    this.#form = options.form;
    this.#input = options.input;
    this.#button = options.button;
    this.#status = options.status;
    this.#counter = options.counter;
    this.#idleButtonText = options.button.textContent ?? "Send message";
    this.syncDraft();
  }

  syncDraft(): void {
    const length = this.#input.value.length;
    this.#counter.textContent = taskMessageCharacterCount(this.#input.value);
    this.#counter.setAttribute(
      "aria-label",
      `${length} of ${TASK_MESSAGE_MAX_LENGTH} characters`,
    );
    this.#button.disabled =
      this.#sending || !taskMessageCanSubmit(this.#input.value);
  }

  begin(focusTarget: TaskMessageFocusTarget): void {
    this.#focusTarget = focusTarget;
    this.#idleButtonText = this.#button.textContent ?? this.#idleButtonText;
    this.#sending = true;
    this.#form.setAttribute("aria-busy", "true");
    this.#input.disabled = true;
    this.#button.setAttribute("aria-busy", "true");
    this.#button.textContent = "Sending…";
    this.#status.textContent = "Sending message…";
    this.syncDraft();
  }

  succeed(taskStillOpen: boolean): void {
    if (taskStillOpen) {
      this.#input.value = "";
      this.#status.textContent = "Message saved.";
      return;
    }
    this.#status.textContent = "";
  }

  fail(taskStillOpen: boolean, deliveryUncertain = false): void {
    this.#status.textContent = taskStillOpen
      ? deliveryUncertain
        ? "Delivery uncertain. Draft preserved."
        : "Message not sent. Draft preserved."
      : "";
  }

  end(restoreFocus: boolean): void {
    this.#sending = false;
    this.#form.removeAttribute("aria-busy");
    this.#input.disabled = false;
    this.#button.removeAttribute("aria-busy");
    this.#button.textContent = this.#idleButtonText;
    this.syncDraft();
    const focusTarget = this.#focusTarget;
    this.#focusTarget = null;
    if (!restoreFocus) return;
    if (focusTarget === "input") {
      this.#input.focus({ preventScroll: true });
    } else if (focusTarget === "button") {
      this.#button.focus({ preventScroll: true });
    }
  }
}
