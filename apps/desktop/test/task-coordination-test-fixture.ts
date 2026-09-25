import type {
  TaskCoordinationDeliveryState,
  TaskCoordinationMessage,
  TaskCoordinationOperatorInbox,
} from "../src/shared.js";
import type { TaskCoordinationInboxElements } from "../src/renderer/task-coordination-inbox.js";

export const COORDINATION_TEST_TIMESTAMPS = {
  created: "2026-08-30T00:00:00.000Z",
  delivered: "2026-08-30T00:00:10.000Z",
  read: "2026-08-30T00:00:20.000Z",
  acknowledged: "2026-08-30T00:00:30.000Z",
  cancelled: "2026-08-30T00:00:40.000Z",
  replied: "2026-08-30T00:00:40.000Z",
  expired: "2026-08-30T00:00:50.000Z",
  generated: "2026-08-30T00:01:00.000Z",
  futureExpiry: "2026-08-30T00:02:00.000Z",
} as const;

function deliveredRecipient(taskId: string) {
  return {
    taskId,
    taskTitle: "Recipient Task",
    taskStatus: "running" as const,
    intendedAgentId: "recipient-agent",
    intendedAgentName: "Recipient Agent",
    deliveredSessionId: "recipient-mailbox",
    deliveredAgentId: "recipient-agent",
    deliveredAgentName: "Recipient Agent",
    ownershipCurrent: true,
    principalCurrent: true,
  };
}

export function coordinationMessage(
  taskId = "recipient-task",
  state: TaskCoordinationDeliveryState = "queued",
  overrides: Partial<TaskCoordinationMessage> = {},
): TaskCoordinationMessage {
  const base: TaskCoordinationMessage = {
    schemaVersion: "scr.task-coordination-message/v2",
    id: `message-${taskId}`,
    ordinal: 1,
    recipientSequence: 1,
    senderSequence: 1,
    kind: "request",
    sender: {
      taskId: "sender",
      taskTitle: "Sender Task",
      sessionId: "mailbox",
      agentId: "agent",
      agentName: "Agent",
    },
    recipient: {
      ...deliveredRecipient(taskId),
      deliveredSessionId: null,
      deliveredAgentId: null,
      deliveredAgentName: null,
    },
    content: `Message for ${taskId}`,
    correlationId: "correlation",
    replyToMessageId: null,
    requiresAcknowledgement: true,
    createdAt: COORDINATION_TEST_TIMESTAMPS.created,
    expiresAt: null,
    deliveredAt: null,
    readAt: null,
    acknowledgedAt: null,
    repliedAt: null,
    cancelledAt: null,
    expiredAt: null,
    deliveryState: "queued",
  };
  const delivered = {
    recipient: deliveredRecipient(taskId),
    deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
  };
  const stateFields: Partial<TaskCoordinationMessage> =
    state === "delivered"
      ? delivered
      : state === "read"
        ? { ...delivered, readAt: COORDINATION_TEST_TIMESTAMPS.read }
        : state === "acknowledged"
          ? {
              ...delivered,
              readAt: COORDINATION_TEST_TIMESTAMPS.read,
              acknowledgedAt: COORDINATION_TEST_TIMESTAMPS.acknowledged,
            }
          : state === "replied"
            ? {
                ...delivered,
                readAt: COORDINATION_TEST_TIMESTAMPS.read,
                acknowledgedAt: COORDINATION_TEST_TIMESTAMPS.acknowledged,
                repliedAt: COORDINATION_TEST_TIMESTAMPS.replied,
              }
            : state === "cancelled"
              ? { cancelledAt: COORDINATION_TEST_TIMESTAMPS.cancelled }
              : state === "expired"
                ? {
                    expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
                    expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
                  }
                : state === "recipient-changed"
                  ? {
                      recipient: {
                        ...base.recipient,
                        ownershipCurrent: false,
                        principalCurrent: false,
                      },
                    }
                  : {};
  const stateRecipient = stateFields.recipient ?? base.recipient;
  return {
    ...base,
    ...stateFields,
    ...overrides,
    recipient: {
      ...stateRecipient,
      ...overrides.recipient,
    },
    deliveryState: overrides.deliveryState ?? state,
  };
}

function isPending(message: TaskCoordinationMessage): boolean {
  return (
    message.recipient.principalCurrent &&
    message.cancelledAt === null &&
    message.repliedAt === null &&
    message.expiredAt === null &&
    (message.requiresAcknowledgement
      ? message.acknowledgedAt === null
      : message.readAt === null)
  );
}

export function coordinationPage(
  taskId = "recipient-task",
  overrides: Partial<TaskCoordinationMessage> = {},
): TaskCoordinationOperatorInbox {
  const message = coordinationMessage(
    taskId,
    overrides.deliveryState ?? "queued",
    overrides,
  );
  const pending = isPending(message);
  return {
    schemaVersion: "scr.task-coordination-operator-inbox/v1",
    taskId,
    generatedAt: COORDINATION_TEST_TIMESTAMPS.generated,
    messages: [message],
    unreadCount: pending && message.readAt === null ? 1 : 0,
    pendingCount: pending ? 1 : 0,
    firstSequence: 1,
    lastSequence: 1,
    nextBeforeSequence: null,
    truncated: false,
  };
}

/** The small DOM surface used by the real rendering functions, without a browser. */
export class InboxTestElement {
  children: InboxTestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  className = "";
  dateTime = "";
  disabled = false;
  hidden = false;
  scrollTop = 0;
  replacements = 0;
  #text = "";

  constructor(readonly tag: string, readonly ownerDocument: InboxTestDocument) {}

  get scrollHeight(): number {
    return this.children.length * 40;
  }
  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join(" ");
  }
  set textContent(value: string) {
    this.#text = value;
    this.children = [];
  }
  append(...children: InboxTestElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: InboxTestElement[]): void {
    this.#text = "";
    this.children = children;
    this.replacements += 1;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "data-task-id") delete this.dataset.taskId;
  }
  addEventListener(name: string, callback: () => void): void {
    this.listeners.set(name, callback);
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  click(): void {
    if (this.disabled || this.hidden) return;
    this.focus();
    this.listeners.get("click")?.();
  }
}

export class InboxTestDocument {
  activeElement: InboxTestElement | null = null;

  createElement(tag: string): InboxTestElement {
    return new InboxTestElement(tag, this);
  }
}

export function inboxElements() {
  const document = new InboxTestDocument();
  const container = document.createElement("div");
  const pendingCount = document.createElement("span");
  const unreadCount = document.createElement("span");
  const snapshotStatus = document.createElement("p");
  const loadOlderButton = document.createElement("button");
  const loadOlderStatus = document.createElement("span");
  const button = document.createElement("button");
  return {
    container,
    pendingCount,
    unreadCount,
    snapshotStatus,
    loadOlderButton,
    loadOlderStatus,
    button,
    elements: {
      container,
      pendingCount,
      unreadCount,
      snapshotStatus,
      loadOlderButton,
      loadOlderStatus,
    } as unknown as TaskCoordinationInboxElements,
    refreshButton: button as unknown as HTMLButtonElement,
  };
}
