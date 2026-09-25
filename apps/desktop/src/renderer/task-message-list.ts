import type { DesktopTaskMessage, DesktopTaskSummary } from "../shared.js";

export interface TaskMessageDeliveryPresentation {
  readonly label: string;
  readonly tone: "acknowledged" | "pending" | "stored";
  readonly title: string;
}

export interface TaskMessageListOptions {
  readonly container: HTMLElement;
  readonly messages: readonly DesktopTaskMessage[];
  readonly task: DesktopTaskSummary;
  readonly messagesTruncated: boolean;
  readonly authorLabel: (message: DesktopTaskMessage) => string;
  readonly timestampLabel: (value: string) => string;
  readonly userDelivery: (
    message: DesktopTaskMessage,
    task: DesktopTaskSummary,
  ) => TaskMessageDeliveryPresentation;
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function sourceText<T extends HTMLElement>(element: T): T {
  element.setAttribute("data-no-i18n", "");
  return element;
}

function requiredChild<T extends HTMLElement>(
  row: HTMLElement,
  selector: string,
): T {
  const child = row.querySelector<T>(selector);
  if (child === null) {
    throw new Error(`Task message row is missing ${selector}.`);
  }
  return child;
}

function createMessageRow(document: Document, messageId: string): HTMLElement {
  const article = document.createElement("article");
  article.dataset.messageId = messageId;

  const header = document.createElement("header");
  const author = sourceText(document.createElement("strong"));
  author.className = "task-message-author";
  const meta = document.createElement("span");
  meta.className = "task-message-header-meta";
  const time = document.createElement("time");
  time.className = "task-message-time";
  meta.append(time);
  header.append(author, meta);

  const content = sourceText(document.createElement("p"));
  content.className = "task-message-content";
  article.append(header, content);
  return article;
}

function updateMessageRow(
  row: HTMLElement,
  message: DesktopTaskMessage,
  task: DesktopTaskSummary,
  options: Pick<
    TaskMessageListOptions,
    "authorLabel" | "timestampLabel" | "userDelivery"
  >,
): void {
  row.dataset.messageId = message.id;
  row.dataset.messageSequence = String(message.sequence);
  const className = `task-message task-message-${message.role}`;
  if (row.className !== className) row.className = className;

  setText(
    sourceText(requiredChild<HTMLElement>(row, ".task-message-author")),
    options.authorLabel(message),
  );
  const meta = requiredChild<HTMLElement>(row, ".task-message-header-meta");
  const time = requiredChild<HTMLTimeElement>(row, ".task-message-time");

  let receipt = meta.querySelector<HTMLElement>(".task-message-delivery");
  if (message.role === "user") {
    if (receipt === null) {
      receipt = row.ownerDocument.createElement("span");
      meta.insertBefore(receipt, time);
    }
    const delivery = options.userDelivery(message, task);
    const receiptClass = `task-message-delivery task-message-delivery-${delivery.tone}`;
    if (receipt.className !== receiptClass) receipt.className = receiptClass;
    setText(receipt, delivery.label);
    if (receipt.title !== delivery.title) receipt.title = delivery.title;
  } else {
    receipt?.remove();
  }

  if (time.dateTime !== message.createdAt) time.dateTime = message.createdAt;
  setText(time, options.timestampLabel(message.createdAt));
  setText(
    sourceText(requiredChild<HTMLElement>(row, ".task-message-content")),
    message.content,
  );
}

interface TaskMessageOrderItem {
  readonly id: string;
  readonly sequence: number;
}

export function validateTaskMessageOrder(
  messages: readonly TaskMessageOrderItem[],
): void {
  const ids = new Set<string>();
  let previousSequence: number | null = null;
  for (const message of messages) {
    if (message.id.trim().length === 0) {
      throw new Error("Task message order omitted a message identity.");
    }
    if (ids.has(message.id)) {
      throw new Error(`Task message order duplicated message ${message.id}.`);
    }
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0) {
      throw new Error(
        "Task message order contains an invalid sequence number.",
      );
    }
    if (previousSequence !== null && message.sequence <= previousSequence) {
      throw new Error(
        "Task message order requires a strictly increasing sequence; message sequences must increase strictly.",
      );
    }
    ids.add(message.id);
    previousSequence = message.sequence;
  }
}

export function validateTaskMessagePage(
  messages: readonly DesktopTaskMessage[],
  task: Pick<DesktopTaskSummary, "id" | "messageCount">,
  messagesTruncated: boolean,
): void {
  if (!Number.isSafeInteger(task.messageCount) || task.messageCount < 0) {
    throw new Error("Task message page has an invalid message count.");
  }
  if (messages.length > task.messageCount) {
    throw new Error(
      "Task message page returned more messages than its declared total.",
    );
  }
  if (messagesTruncated !== messages.length < task.messageCount) {
    throw new Error(
      "Task message page has inconsistent message truncation metadata.",
    );
  }

  const ids = new Set<string>();
  let previousSequence = 0;
  for (const message of messages) {
    if (message.id.trim().length === 0 || ids.has(message.id)) {
      throw new Error("Task message page duplicated or omitted a message ID.");
    }
    if (message.taskId !== task.id) {
      throw new Error("Task message page returned a message for another task.");
    }
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0) {
      throw new Error("Task message page returned an invalid sequence.");
    }
    if (message.sequence <= previousSequence) {
      throw new Error(
        "Task message page is not in strictly increasing sequence order.",
      );
    }
    ids.add(message.id);
    previousSequence = message.sequence;
  }
}

function reconcileMetaRow(
  container: HTMLElement,
  selector: string,
  className: string,
  text: string | null,
): HTMLElement | null {
  let row = container.querySelector<HTMLElement>(`:scope > ${selector}`);
  if (text === null) {
    row?.remove();
    return null;
  }
  if (row === null) {
    row = container.ownerDocument.createElement("div");
    row.className = className;
  }
  setText(row, text);
  return row;
}

export function validateTaskMessageSnapshot(
  messages: readonly DesktopTaskMessage[],
  taskId: string,
  messageCount: number,
  messagesTruncated: boolean,
): void {
  if (!Number.isSafeInteger(messageCount) || messageCount < 0) {
    throw new Error("Task message count is invalid.");
  }
  if (messages.length > messageCount) {
    throw new Error(
      "Task message snapshot exceeds its declared message count.",
    );
  }
  if (!messagesTruncated && messages.length !== messageCount) {
    throw new Error(
      "Task message snapshot is incomplete without truncation metadata.",
    );
  }
  if (messagesTruncated && messages.length >= messageCount) {
    throw new Error(
      "Task message snapshot has inconsistent truncation metadata.",
    );
  }
  validateTaskMessageOrder(messages);
  for (const message of messages) {
    if (message.taskId !== taskId) {
      throw new Error(`Task message ${message.id} belongs to another task.`);
    }
  }
}
export function reconcileTaskMessageList(
  options: TaskMessageListOptions,
): void {
  const { container, messages, task, messagesTruncated } = options;
  validateTaskMessageSnapshot(
    messages,
    task.id,
    task.messageCount,
    messagesTruncated,
  );
  validateTaskMessagePage(messages, task, messagesTruncated);
  const previousTaskId = container.dataset.taskId ?? null;
  const taskChanged = previousTaskId !== task.id;
  const wasNearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const previousScrollTop = container.scrollTop;
  const previousFirst = container.querySelector<HTMLElement>(".task-message[data-message-id]");
  const prepended = !taskChanged && previousFirst !== null &&
    (messages[0]?.sequence ?? Infinity) < Number(previousFirst.dataset.messageSequence);
  const anchor = taskChanged ? null : [...container.querySelectorAll<HTMLElement>(".task-message[data-message-id]")]
    .find((row) => row.getBoundingClientRect().bottom > container.getBoundingClientRect().top) ?? null;
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;

  if (taskChanged) {
    for (const child of [...container.children]) child.remove();
    container.dataset.taskId = task.id;
  }

  const existing = new Map(
    [
      ...container.querySelectorAll<HTMLElement>(
        ":scope > .task-message[data-message-id]",
      ),
    ].map((row) => [row.dataset.messageId ?? "", row] as const),
  );
  const incomingIds = new Set<string>();
  const desired: HTMLElement[] = [];

  const truncated = reconcileMetaRow(
    container,
    ".task-conversation-truncated",
    "task-conversation-truncated",
    messagesTruncated
      ? `Showing the latest ${messages.length} of ${task.messageCount} messages.`
      : null,
  );
  if (truncated !== null) desired.push(truncated);

  if (messages.length === 0) {
    const empty = reconcileMetaRow(
      container,
      ".task-detail-empty",
      "task-detail-empty",
      "No conversation yet.",
    );
    if (empty !== null) desired.push(empty);
  } else {
    reconcileMetaRow(
      container,
      ".task-detail-empty",
      "task-detail-empty",
      null,
    );
    for (const message of messages) {
      if (incomingIds.has(message.id)) {
        throw new Error(`Task message list duplicated message ${message.id}.`);
      }
      incomingIds.add(message.id);
      const row =
        existing.get(message.id) ??
        createMessageRow(container.ownerDocument, message.id);
      existing.delete(message.id);
      updateMessageRow(row, message, task, options);
      desired.push(row);
    }
  }

  for (const row of existing.values()) row.remove();
  const desiredSet = new Set(desired);
  for (const child of [...container.children]) {
    if (!desiredSet.has(child as HTMLElement)) child.remove();
  }

  let cursor = container.firstElementChild;
  for (const row of desired) {
    if (row === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      container.insertBefore(row, cursor);
    }
  }

  if (!taskChanged && anchor?.parentElement === container && (prepended || !wasNearBottom)) {
    container.scrollTop = Math.max(0, container.scrollTop + anchor.getBoundingClientRect().top - anchorTop);
  } else if (taskChanged || wasNearBottom || messages.length <= 2) {
    container.scrollTop = container.scrollHeight;
  } else if (container.scrollTop !== previousScrollTop) {
    container.scrollTop = previousScrollTop;
  }
}
