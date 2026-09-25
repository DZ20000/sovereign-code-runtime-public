import type { DesktopTaskDetail, DesktopTaskMessage, DesktopTaskSummary, SovereignDesktopApi } from "../shared.js";
import { assertTaskDetailIntegrity } from "./task-detail-integrity.js";

interface TaskMessageHistoryView {
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly render: (messages: readonly DesktopTaskMessage[], task: DesktopTaskSummary, truncated: boolean) => void;
}

/** Owns the bounded conversation windows independently of task/coordination refreshes. */
export class TaskMessageHistory {
  #taskId: string | null = null;
  #detail: DesktopTaskDetail | null = null;
  #messages: readonly DesktopTaskMessage[] = [];
  #exhausted = false;
  #generation = 0;
  #pending: Promise<void> | null = null;
  #syncDetail: DesktopTaskDetail | null = null;

  constructor(
    readonly api: Pick<SovereignDesktopApi, "getTaskDetail">,
    readonly view: TaskMessageHistoryView,
  ) {
    view.button.addEventListener("click", () => { void this.loadOlder(); });
  }

  select(taskId: string | null): void {
    if (this.#taskId === taskId) return;
    this.#taskId = taskId;
    this.#detail = null;
    this.#messages = [];
    this.#exhausted = false;
    this.#generation += 1;
    this.#pending = null;
    this.#syncDetail = null;
    this.view.button.hidden = true;
    this.view.button.disabled = false;
    this.view.button.textContent = "Load earlier messages";
    this.view.button.removeAttribute("aria-busy");
    this.view.status.textContent = "";
  }

  update(detail: DesktopTaskDetail): void {
    assertTaskDetailIntegrity(detail.task.id, detail);
    this.select(detail.task.id);
    if (this.#syncDetail !== null) {
      this.#syncDetail = detail;
      void this.loadOlder();
      return;
    }
    const previous = this.#messages;
    const previousIds = new Set(previous.map((message) => message.id));
    const overlaps = detail.messages.some((message) => previousIds.has(message.id));
    let messages = detail.messages;
    if (detail.messagesTruncated && overlaps) {
      const first = detail.oldestMessageSequence!;
      messages = [...previous.filter((message) => message.sequence < first), ...detail.messages];
      try {
        assertTaskDetailIntegrity(detail.task.id, this.#window(detail, messages));
      } catch {
        // Keep the accepted window visible until its older receipts have been read again.
        this.#syncDetail = detail;
        this.#generation += 1;
        this.#pending = null;
        void this.loadOlder();
        return;
      }
    }
    const historyReset = previous.length > 0 && !messages.some((message) => message.id === previous[0]?.id);
    if (historyReset) {
      this.#generation += 1;
      this.#pending = null;
      this.view.button.removeAttribute("aria-busy");
      this.view.status.textContent = "Conversation changed. Earlier messages can be loaded again.";
    }
    this.#detail = detail;
    this.#messages = messages;
    this.#exhausted = messages.length === detail.task.messageCount;
    this.#render();
  }

  loadOlder(): Promise<void> {
    if (this.#pending !== null) return this.#pending;
    if (this.#syncDetail !== null) return this.#synchronize();
    const detail = this.#detail;
    const before = this.#messages[0]?.sequence;
    if (detail === null || before === undefined || this.#exhausted) return Promise.resolve();
    const generation = this.#generation;
    this.view.button.disabled = true;
    this.view.button.setAttribute("aria-busy", "true");
    this.view.status.textContent = "Loading earlier messages…";
    const pending = (async () => {
      try {
        const page = await this.#readOlder(detail.task.id, before);
        if (generation !== this.#generation || this.#detail === null) return;
        const messages = [...page.messages, ...this.#messages];
        assertTaskDetailIntegrity(detail.task.id, this.#window(this.#detail, messages));
        this.#messages = messages;
        this.#exhausted = messages.length === this.#detail.task.messageCount;
        this.#render();
        this.view.status.textContent = this.#exhausted
          ? "All available messages are shown."
          : "Earlier messages loaded.";
      } catch {
        if (generation !== this.#generation) return;
        this.view.status.textContent = "Could not load earlier messages. Loaded messages were retained; try again.";
      } finally {
        if (generation === this.#generation) {
          this.#pending = null;
          this.view.button.disabled = false;
          this.view.button.removeAttribute("aria-busy");
        }
      }
    })();
    this.#pending = pending;
    return pending;
  }

  async #readOlder(taskId: string, before: number): Promise<DesktopTaskDetail> {
    const page = await this.api.getTaskDetail(taskId, 100, before);
    assertTaskDetailIntegrity(taskId, page);
    if (page.messages.length === 0) {
      throw new Error("Conversation history ended before all retained messages were read.");
    }
    if (page.messages.some((message) => message.sequence >= before)) {
      throw new Error("Conversation history did not advance before its cursor.");
    }
    return page;
  }

  #synchronize(): Promise<void> {
    const detail = this.#syncDetail!;
    const oldest = this.#messages[0]!.sequence;
    const generation = this.#generation;
    this.view.button.hidden = false;
    this.view.button.disabled = true;
    this.view.button.textContent = "Retry message sync";
    this.view.button.setAttribute("aria-busy", "true");
    this.view.status.textContent = "Syncing message acknowledgements… Loaded messages remain visible.";
    const pending = Promise.resolve().then(async () => {
      try {
        let messages = detail.messages;
        while ((messages[0]?.sequence ?? Infinity) > oldest) {
          const before = messages[0]?.sequence;
          if (before === undefined) throw new Error("Conversation history has no cursor.");
          const page = await this.#readOlder(detail.task.id, before);
          if (generation !== this.#generation || this.#syncDetail === null) return;
          messages = [...page.messages, ...messages];
        }
        if (generation !== this.#generation || this.#syncDetail === null) return;
        const latest = this.#syncDetail;
        const refreshedIds = new Set(messages.map((message) => message.id));
        if (latest.messagesTruncated && !latest.messages.some((message) => refreshedIds.has(message.id))) {
          throw new Error("Conversation changed while its acknowledgements were syncing.");
        }
        messages = latest.messagesTruncated
          ? [...messages.filter((message) => message.sequence < latest.oldestMessageSequence!), ...latest.messages]
          : latest.messages;
        assertTaskDetailIntegrity(detail.task.id, this.#window(latest, messages));
        this.#detail = latest;
        this.#messages = messages;
        this.#syncDetail = null;
        this.#exhausted = messages.length === latest.task.messageCount;
        this.#render();
        this.view.status.textContent = "Message acknowledgements synchronized.";
      } catch {
        if (generation !== this.#generation) return;
        this.view.status.textContent = "Could not sync message acknowledgements. Loaded messages were retained; try again.";
      } finally {
        if (generation === this.#generation) {
          this.#pending = null;
          this.view.button.hidden = this.#exhausted && this.#syncDetail === null;
          this.view.button.disabled = false;
          this.view.button.removeAttribute("aria-busy");
        }
      }
    });
    this.#pending = pending;
    return pending;
  }

  #window(detail: DesktopTaskDetail, messages: readonly DesktopTaskMessage[]): DesktopTaskDetail {
    return {
      ...detail,
      messages,
      messagesTruncated: messages.length < detail.task.messageCount,
      oldestMessageSequence: messages[0]?.sequence ?? null,
      newestMessageSequence: messages.at(-1)?.sequence ?? null,
    };
  }

  #render(): void {
    if (this.#detail === null) return;
    this.view.render(this.#messages, this.#detail.task, this.#messages.length < this.#detail.task.messageCount);
    this.view.button.textContent = "Load earlier messages";
    this.view.button.hidden = this.#exhausted;
    this.view.button.disabled = this.#pending !== null;
  }
}
