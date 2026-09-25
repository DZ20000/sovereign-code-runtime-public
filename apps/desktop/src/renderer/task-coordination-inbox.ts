import {
  TASK_COORDINATION_MESSAGE_SCHEMA_VERSION,
  TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION,
  validateTaskCoordinationMessageCausality,
  type SovereignDesktopApi,
  type TaskCoordinationDeliveryState,
  type TaskCoordinationKind,
  type TaskCoordinationMessage,
  type TaskCoordinationOperatorInbox,
} from "../shared.js";

const MESSAGE_KINDS = new Set<TaskCoordinationKind>([
  "message",
  "question",
  "request",
  "handoff",
  "decision",
  "notice",
  "freeze",
  "release-request",
  "release-result",
]);
const DELIVERY_STATES = new Set<TaskCoordinationDeliveryState>([
  "queued",
  "delivered",
  "read",
  "acknowledged",
  "replied",
  "cancelled",
  "expired",
  "recipient-changed",
]);
const KIND_LABELS: Readonly<Record<TaskCoordinationKind, string>> = {
  message: "Message",
  question: "Question",
  request: "Request",
  handoff: "Handoff",
  decision: "Decision",
  notice: "Notice",
  freeze: "Freeze",
  "release-request": "Release request",
  "release-result": "Release result",
};
const DELIVERY_LABELS: Readonly<Record<TaskCoordinationDeliveryState, string>> =
  {
    queued: "Queued",
    delivered: "Delivered",
    read: "Read",
    acknowledged: "Acknowledged",
    replied: "Replied",
    cancelled: "Cancelled",
    expired: "Expired",
    "recipient-changed": "Recipient changed",
  };

export const TASK_COORDINATION_LOAD_TIMEOUT_MS = 10_000;
export const TASK_COORDINATION_PAGE_LIMIT = 50;

export interface TaskCoordinationInboxElements {
  readonly container: HTMLElement;
  readonly pendingCount: HTMLElement;
  readonly unreadCount: HTMLElement;
  readonly snapshotStatus: HTMLElement;
  readonly loadOlderButton: HTMLButtonElement;
  readonly loadOlderStatus: HTMLElement;
}

export interface TaskCoordinationInboxLoadResult {
  readonly inbox: TaskCoordinationOperatorInbox | null;
  readonly error: unknown | null;
}

export type TaskCoordinationHistoryStatus =
  | "idle"
  | "loading"
  | "loaded"
  | "error";

export type TaskCoordinationSnapshotStatus =
  | "idle"
  | "loading"
  | "unavailable"
  | "fresh"
  | "stale";

export type TaskCoordinationScrollMode = "preserve" | "prepend";

export interface TaskCoordinationInboxRenderOptions {
  readonly scrollMode?: TaskCoordinationScrollMode;
  readonly stale?: boolean;
  readonly lastUpdatedAt?: string;
}

function safeInteger(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function requiredTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validTimestamp(value: unknown): boolean {
  return value === null || requiredTimestamp(value);
}

function safeSingleLineText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

function requiredIdentity(value: unknown): value is string {
  return safeSingleLineText(value, 160) && !/\s/u.test(value);
}

function optionalIdentity(value: unknown): boolean {
  return value === null || requiredIdentity(value);
}

function optionalName(value: unknown): boolean {
  return value === null || safeSingleLineText(value, 160);
}

function validateMessage(
  requestedTaskId: string,
  message: TaskCoordinationMessage,
  previousSequence: number,
  ids: Set<string>,
  generatedAt: string,
): void {
  if (message.schemaVersion !== TASK_COORDINATION_MESSAGE_SCHEMA_VERSION) {
    throw new Error(
      "Coordination inbox returned an unsupported message schema.",
    );
  }
  if (!requiredIdentity(message.id) || ids.has(message.id)) {
    throw new Error(
      "Coordination inbox contains an empty or duplicate message ID.",
    );
  }
  if (
    !safeInteger(message.ordinal, 1) ||
    !safeInteger(message.recipientSequence, 1) ||
    !safeInteger(message.senderSequence, 1) ||
    message.recipientSequence <= previousSequence
  ) {
    throw new Error("Coordination inbox is not in increasing recipient order.");
  }
  if (
    message.recipient.taskId !== requestedTaskId ||
    !requiredIdentity(message.sender.taskId) ||
    !safeSingleLineText(message.sender.taskTitle, 200) ||
    !requiredIdentity(message.sender.sessionId) ||
    !requiredIdentity(message.sender.agentId) ||
    !safeSingleLineText(message.sender.agentName, 160) ||
    !safeSingleLineText(message.recipient.taskTitle, 200) ||
    !optionalIdentity(message.recipient.intendedAgentId) ||
    !optionalName(message.recipient.intendedAgentName) ||
    !optionalIdentity(message.recipient.deliveredSessionId) ||
    !optionalIdentity(message.recipient.deliveredAgentId) ||
    !optionalName(message.recipient.deliveredAgentName) ||
    !requiredIdentity(message.correlationId) ||
    !optionalIdentity(message.replyToMessageId) ||
    typeof message.requiresAcknowledgement !== "boolean" ||
    typeof message.recipient.ownershipCurrent !== "boolean" ||
    typeof message.recipient.principalCurrent !== "boolean"
  ) {
    throw new Error(
      "Coordination inbox contains an invalid participant identity.",
    );
  }
  if (
    !MESSAGE_KINDS.has(message.kind) ||
    !DELIVERY_STATES.has(message.deliveryState)
  ) {
    throw new Error(
      "Coordination inbox contains an unsupported kind or state.",
    );
  }
  if (
    typeof message.content !== "string" ||
    message.content.trim().length === 0 ||
    message.content.length > 8_000 ||
    [...message.content].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
        code === 0x7f
      );
    })
  ) {
    throw new Error("Coordination inbox contains invalid message content.");
  }
  if (!requiredTimestamp(message.createdAt)) {
    throw new Error(
      "Coordination inbox contains an invalid creation timestamp.",
    );
  }
  for (const timestamp of [
    message.expiresAt,
    message.deliveredAt,
    message.readAt,
    message.acknowledgedAt,
    message.repliedAt,
    message.cancelledAt,
    message.expiredAt,
  ]) {
    if (!validTimestamp(timestamp)) {
      throw new Error("Coordination inbox contains an invalid timestamp.");
    }
  }
  validateTaskCoordinationMessageCausality(message, generatedAt);
  ids.add(message.id);
}

function validateTaskCoordinationSnapshot(
  requestedTaskId: string,
  inbox: TaskCoordinationOperatorInbox,
  maximumMessages: number | null,
): void {
  if (
    inbox.schemaVersion !== TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION ||
    inbox.taskId !== requestedTaskId ||
    !requiredTimestamp(inbox.generatedAt)
  ) {
    throw new Error("Coordination inbox identity or schema is invalid.");
  }
  if (
    !safeInteger(inbox.pendingCount) ||
    !safeInteger(inbox.unreadCount) ||
    inbox.unreadCount > inbox.pendingCount ||
    !Array.isArray(inbox.messages) ||
    (maximumMessages !== null && inbox.messages.length > maximumMessages)
  ) {
    throw new Error("Coordination inbox count or page size is invalid.");
  }
  const ids = new Set<string>();
  let previousSequence = 0;
  for (const message of inbox.messages) {
    validateMessage(
      requestedTaskId,
      message,
      previousSequence,
      ids,
      inbox.generatedAt,
    );
    previousSequence = message.recipientSequence;
  }
  const expectedFirst = inbox.messages[0]?.recipientSequence ?? null;
  const expectedLast = inbox.messages.at(-1)?.recipientSequence ?? null;
  if (
    inbox.firstSequence !== expectedFirst ||
    inbox.lastSequence !== expectedLast ||
    inbox.truncated !== (inbox.nextBeforeSequence !== null)
  ) {
    throw new Error("Coordination inbox page metadata is inconsistent.");
  }
  if (
    inbox.nextBeforeSequence !== null &&
    (!safeInteger(inbox.nextBeforeSequence, 1) ||
      inbox.nextBeforeSequence !== expectedFirst)
  ) {
    throw new Error("Coordination inbox continuation cursor is invalid.");
  }
}

export function validateTaskCoordinationInbox(
  requestedTaskId: string,
  inbox: TaskCoordinationOperatorInbox,
): void {
  validateTaskCoordinationSnapshot(requestedTaskId, inbox, 100);
}

function mergeCoordinationMessages(
  current: readonly TaskCoordinationMessage[],
  incoming: readonly TaskCoordinationMessage[],
  preferIncoming: boolean,
): TaskCoordinationMessage[] {
  const bySequence = new Map<number, TaskCoordinationMessage>();
  const sequenceById = new Map<string, number>();
  const add = (message: TaskCoordinationMessage, replace: boolean): void => {
    const knownSequence = sequenceById.get(message.id);
    if (
      knownSequence !== undefined &&
      knownSequence !== message.recipientSequence
    ) {
      throw new Error("Coordination inbox message identity changed between pages.");
    }
    const knownMessage = bySequence.get(message.recipientSequence);
    if (knownMessage !== undefined && knownMessage.id !== message.id) {
      throw new Error("Coordination inbox sequence changed between pages.");
    }
    if (knownMessage === undefined || replace) {
      bySequence.set(message.recipientSequence, message);
    }
    sequenceById.set(message.id, message.recipientSequence);
  };
  for (const message of current) add(message, false);
  for (const message of incoming) add(message, preferIncoming);
  return [...bySequence.values()].sort(
    (left, right) => left.recipientSequence - right.recipientSequence,
  );
}

function mergedSnapshot(
  source: TaskCoordinationOperatorInbox,
  messages: readonly TaskCoordinationMessage[],
  nextBeforeSequence: number | null,
): TaskCoordinationOperatorInbox {
  const result: TaskCoordinationOperatorInbox = {
    ...source,
    messages,
    firstSequence: messages[0]?.recipientSequence ?? null,
    lastSequence: messages.at(-1)?.recipientSequence ?? null,
    nextBeforeSequence,
    truncated: nextBeforeSequence !== null,
  };
  validateTaskCoordinationSnapshot(result.taskId, result, null);
  return result;
}

export function mergeTaskCoordinationLatestPage(
  current: TaskCoordinationOperatorInbox | null,
  latest: TaskCoordinationOperatorInbox,
): TaskCoordinationOperatorInbox {
  validateTaskCoordinationInbox(latest.taskId, latest);
  if (current === null) return latest;
  validateTaskCoordinationSnapshot(current.taskId, current, null);
  if (current.taskId !== latest.taskId) {
    throw new Error("Coordination inbox Task changed while merging pages.");
  }
  const currentFirst = current.messages[0]?.recipientSequence ?? null;
  const latestFirst = latest.messages[0]?.recipientSequence ?? null;
  const currentOwnsOldestBoundary =
    currentFirst !== null &&
    (latestFirst === null || currentFirst < latestFirst);
  return mergedSnapshot(
    latest,
    mergeCoordinationMessages(current.messages, latest.messages, true),
    currentOwnsOldestBoundary
      ? current.nextBeforeSequence
      : latest.nextBeforeSequence,
  );
}

export function mergeTaskCoordinationOlderPage(
  current: TaskCoordinationOperatorInbox,
  older: TaskCoordinationOperatorInbox,
  requestedBeforeSequence: number,
): TaskCoordinationOperatorInbox {
  validateTaskCoordinationSnapshot(current.taskId, current, null);
  validateTaskCoordinationInbox(older.taskId, older);
  if (
    current.taskId !== older.taskId ||
    current.nextBeforeSequence !== requestedBeforeSequence
  ) {
    throw new Error("Coordination inbox cursor changed while loading history.");
  }
  if (
    (older.lastSequence !== null &&
      older.lastSequence >= requestedBeforeSequence) ||
    (older.nextBeforeSequence !== null &&
      older.nextBeforeSequence >= requestedBeforeSequence)
  ) {
    throw new Error("Coordination inbox cursor did not move backwards.");
  }
  return mergedSnapshot(
    older,
    mergeCoordinationMessages(current.messages, older.messages, false),
    older.nextBeforeSequence,
  );
}

export async function loadTaskCoordinationInbox(
  api: Pick<SovereignDesktopApi, "getTaskCoordinationInbox">,
  taskId: string,
  beforeSequence?: number,
  limit = TASK_COORDINATION_PAGE_LIMIT,
): Promise<TaskCoordinationInboxLoadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (
      (beforeSequence !== undefined && !safeInteger(beforeSequence, 1)) ||
      !safeInteger(limit, 1) ||
      limit > 100
    ) {
      throw new Error("Coordination inbox request cursor or limit is invalid.");
    }
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Coordination inbox read timed out.")),
        TASK_COORDINATION_LOAD_TIMEOUT_MS,
      );
    });
    const inbox = await Promise.race([
      api.getTaskCoordinationInbox(taskId, beforeSequence, limit),
      timeout,
    ]);
    validateTaskCoordinationInbox(taskId, inbox);
    if (
      beforeSequence !== undefined &&
      ((inbox.lastSequence !== null && inbox.lastSequence >= beforeSequence) ||
        (inbox.nextBeforeSequence !== null &&
          inbox.nextBeforeSequence >= beforeSequence))
    ) {
      throw new Error("Coordination inbox cursor did not move backwards.");
    }
    return { inbox, error: null };
  } catch (error) {
    return { inbox: null, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function taskCoordinationPendingText(count: number): string {
  if (!safeInteger(count)) {
    throw new Error("Coordination pending count is invalid.");
  }
  return count === 0
    ? "No coordination pending"
    : `${count} coordination pending`;
}

export function taskCoordinationUnreadText(count: number): string {
  if (!safeInteger(count)) {
    throw new Error("Coordination unread count is invalid.");
  }
  return count === 0
    ? "No unread coordination"
    : `${count} coordination unread`;
}

function countText(value: string, stale: boolean): string {
  return stale ? `Last known: ${value}` : value;
}

export function renderTaskCoordinationPendingCount(
  element: HTMLElement,
  count: number | null,
  stale = false,
): void {
  const value =
    count === null
      ? "Coordination count unavailable"
      : taskCoordinationPendingText(count);
  element.textContent = count === null ? value : countText(value, stale);
  element.className = [
    "task-coordination-pending-count",
    count !== null && count > 0 ? "has-pending" : "",
    stale ? "is-stale" : "",
  ]
    .filter(Boolean)
    .join(" ");
  element.dataset.freshness =
    count === null ? "unavailable" : stale ? "stale" : "fresh";
}

export function renderTaskCoordinationUnreadCount(
  element: HTMLElement,
  count: number | null,
  stale = false,
): void {
  const value =
    count === null
      ? "Coordination unread count unavailable"
      : taskCoordinationUnreadText(count);
  element.textContent = count === null ? value : countText(value, stale);
  element.className = [
    "task-coordination-unread-count",
    count !== null && count > 0 ? "has-unread" : "",
    stale ? "is-stale" : "",
  ]
    .filter(Boolean)
    .join(" ");
  element.dataset.freshness =
    count === null ? "unavailable" : stale ? "stale" : "fresh";
}

const HISTORY_STATUS_TEXT: Readonly<Record<TaskCoordinationHistoryStatus, string>> = {
  idle: "",
  loading: "Loading earlier coordination…",
  loaded: "Earlier coordination messages loaded.",
  error:
    "Could not load earlier coordination messages. Loaded messages were retained.",
};

export function renderTaskCoordinationHistoryControls(
  elements: TaskCoordinationInboxElements,
  nextBeforeSequence: number | null,
  status: TaskCoordinationHistoryStatus,
  disabled = false,
): void {
  const hasOlder = nextBeforeSequence !== null;
  const moveFocusToList =
    !hasOlder &&
    elements.loadOlderButton.ownerDocument.activeElement ===
      elements.loadOlderButton;
  elements.loadOlderButton.hidden = !hasOlder;
  elements.loadOlderButton.disabled = !hasOlder || disabled || status === "loading";
  elements.loadOlderButton.setAttribute(
    "aria-busy",
    status === "loading" ? "true" : "false",
  );
  if (elements.loadOlderStatus.dataset.renderStatus !== status) {
    elements.loadOlderStatus.dataset.renderStatus = status;
    elements.loadOlderStatus.textContent = HISTORY_STATUS_TEXT[status];
  }
  elements.loadOlderStatus.className =
    status === "error"
      ? "task-coordination-history-status is-error"
      : "task-coordination-history-status";
  if (moveFocusToList) elements.container.focus({ preventScroll: true });
}

export function renderTaskCoordinationSnapshotStatus(
  elements: TaskCoordinationInboxElements,
  status: TaskCoordinationSnapshotStatus,
  lastUpdatedAt: string | null = null,
  timestampLabel: (value: string) => string = (value) => value,
): void {
  if (
    (status === "fresh" || status === "stale") &&
    !requiredTimestamp(lastUpdatedAt)
  ) {
    throw new Error("Coordination snapshot update timestamp is invalid.");
  }
  const formatted =
    lastUpdatedAt === null ? null : timestampLabel(lastUpdatedAt);
  const text =
    status === "idle"
      ? ""
      : status === "loading"
        ? "Loading coordination…"
        : status === "unavailable"
          ? "Coordination status unavailable."
          : status === "stale"
            ? `Coordination messages and counts may be out of date. Last updated ${formatted}.`
            : `Coordination messages and counts updated ${formatted}.`;
  const renderKey = JSON.stringify([status, formatted]);
  if (elements.snapshotStatus.dataset.renderKey !== renderKey) {
    elements.snapshotStatus.dataset.renderKey = renderKey;
    elements.snapshotStatus.textContent = text;
  }
  elements.snapshotStatus.className = [
    "task-coordination-snapshot-status",
    status === "stale" ? "is-stale" : "",
    status === "unavailable" ? "is-unavailable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  elements.container.className =
    status === "stale"
      ? "task-coordination-list is-stale"
      : "task-coordination-list";
  elements.container.dataset.freshness = status;
}

export function renderTaskCoordinationSnapshotFreshness(
  elements: TaskCoordinationInboxElements,
  inbox: TaskCoordinationOperatorInbox,
  lastUpdatedAt: string,
  stale: boolean,
  timestampLabel: (value: string) => string,
): void {
  renderTaskCoordinationPendingCount(
    elements.pendingCount,
    inbox.pendingCount,
    stale,
  );
  renderTaskCoordinationUnreadCount(
    elements.unreadCount,
    inbox.unreadCount,
    stale,
  );
  renderTaskCoordinationSnapshotStatus(
    elements,
    stale ? "stale" : "fresh",
    lastUpdatedAt,
    timestampLabel,
  );
}

function sourceText<T extends HTMLElement>(element: T): T {
  element.setAttribute("data-no-i18n", "");
  return element;
}

function stateRow(
  document: Document,
  className: string,
  text: string,
): HTMLElement {
  const row = document.createElement("p");
  row.className = className;
  row.textContent = text;
  return row;
}

export function renderTaskCoordinationLoading(
  elements: TaskCoordinationInboxElements,
  pendingCount: number | null,
): void {
  renderTaskCoordinationPendingCount(elements.pendingCount, pendingCount);
  renderTaskCoordinationUnreadCount(elements.unreadCount, null);
  renderTaskCoordinationSnapshotStatus(elements, "loading");
  renderTaskCoordinationHistoryControls(elements, null, "idle");
  elements.container.replaceChildren(
    stateRow(
      elements.container.ownerDocument,
      "task-coordination-state",
      "Loading coordination…",
    ),
  );
}

export function renderTaskCoordinationUnavailable(
  elements: TaskCoordinationInboxElements,
  pendingCount: number | null,
): void {
  renderTaskCoordinationPendingCount(elements.pendingCount, pendingCount);
  renderTaskCoordinationUnreadCount(elements.unreadCount, null);
  renderTaskCoordinationSnapshotStatus(elements, "unavailable");
  renderTaskCoordinationHistoryControls(elements, null, "idle");
  elements.container.replaceChildren(
    stateRow(
      elements.container.ownerDocument,
      "task-coordination-state task-coordination-state-error",
      "Could not load coordination messages.",
    ),
  );
}

function requiresAgentAction(message: TaskCoordinationMessage): boolean {
  return (
    message.recipient.principalCurrent &&
    message.requiresAcknowledgement &&
    message.acknowledgedAt === null &&
    message.repliedAt === null &&
    message.cancelledAt === null &&
    message.expiredAt === null
  );
}

function messageRow(
  document: Document,
  message: TaskCoordinationMessage,
  timestampLabel: (value: string) => string,
): HTMLElement {
  const row = document.createElement("article");
  row.className = `task-coordination-message task-coordination-state-${message.deliveryState}`;
  row.dataset.coordinationMessageId = message.id;
  row.dataset.recipientSequence = String(message.recipientSequence);
  row.setAttribute("role", "listitem");

  const header = document.createElement("header");
  const sender = sourceText(document.createElement("strong"));
  sender.textContent = `${message.sender.agentName} · ${message.sender.taskTitle}`;
  const chips = document.createElement("span");
  chips.className = "task-coordination-message-chips";
  const kind = document.createElement("span");
  kind.className = "task-coordination-kind";
  kind.textContent = KIND_LABELS[message.kind];
  const state = document.createElement("span");
  state.className = `task-coordination-delivery task-coordination-delivery-${message.deliveryState}`;
  state.textContent = DELIVERY_LABELS[message.deliveryState];
  chips.append(kind, state);
  header.append(sender, chips);

  const content = sourceText(document.createElement("p"));
  content.className = "task-coordination-content";
  content.textContent = message.content;

  const footer = document.createElement("footer");
  const time = sourceText(document.createElement("time"));
  time.dateTime = message.createdAt;
  time.textContent = timestampLabel(message.createdAt);
  footer.append(time);
  if (requiresAgentAction(message)) {
    const action = document.createElement("span");
    action.className = "task-coordination-action-required";
    action.textContent = "Needs Agent acknowledgement";
    footer.append(action);
  }
  row.append(header, content, footer);
  return row;
}

export function renderTaskCoordinationInbox(
  elements: TaskCoordinationInboxElements,
  inbox: TaskCoordinationOperatorInbox,
  timestampLabel: (value: string) => string,
  options: TaskCoordinationInboxRenderOptions = {},
): void {
  validateTaskCoordinationSnapshot(inbox.taskId, inbox, null);
  const stale = options.stale ?? false;
  const lastUpdatedAt = options.lastUpdatedAt ?? inbox.generatedAt;
  const scrollMode = options.scrollMode ?? "preserve";
  renderTaskCoordinationSnapshotFreshness(
    elements,
    inbox,
    lastUpdatedAt,
    stale,
    timestampLabel,
  );
  renderTaskCoordinationHistoryControls(
    elements,
    inbox.nextBeforeSequence,
    "idle",
  );
  const document = elements.container.ownerDocument;
  const rows: HTMLElement[] = [];
  if (inbox.messages.length === 0) {
    rows.push(
      stateRow(
        document,
        "task-coordination-state",
        "No coordination messages.",
      ),
    );
  } else {
    for (const message of inbox.messages) {
      rows.push(messageRow(document, message, timestampLabel));
    }
  }
  elements.container.dataset.taskId = inbox.taskId;
  const oldScrollTop = elements.container.scrollTop;
  const oldScrollHeight = elements.container.scrollHeight;
  elements.container.replaceChildren(...rows);
  elements.container.scrollTop =
    scrollMode === "prepend"
      ? oldScrollTop +
        Math.max(0, elements.container.scrollHeight - oldScrollHeight)
      : oldScrollTop;
}
