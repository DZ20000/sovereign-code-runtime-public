import type { DesktopTaskStatus } from "./tasks.js";

export const TASK_COORDINATION_MESSAGE_SCHEMA_VERSION =
  "scr.task-coordination-message/v2" as const;
export const TASK_COORDINATION_DIRECTORY_SCHEMA_VERSION =
  "scr.task-coordination-directory/v2" as const;
export const TASK_COORDINATION_INBOX_SCHEMA_VERSION =
  "scr.task-coordination-inbox/v2" as const;
export const TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION =
  "scr.task-coordination-operator-inbox/v1" as const;
export const TASK_COORDINATION_OUTBOX_SCHEMA_VERSION =
  "scr.task-coordination-outbox/v2" as const;
export const TASK_COORDINATION_THREAD_SCHEMA_VERSION =
  "scr.task-coordination-thread/v2" as const;
export const TASK_COORDINATION_PENDING_SCHEMA_VERSION =
  "scr.task-coordination-pending/v2" as const;

export const TASK_COORDINATION_KINDS = [
  "message",
  "question",
  "request",
  "handoff",
  "decision",
  "notice",
  "freeze",
  "release-request",
  "release-result",
] as const;

export type TaskCoordinationKind = (typeof TASK_COORDINATION_KINDS)[number];
export type TaskCoordinationDeliveryState =
  | "queued"
  | "delivered"
  | "read"
  | "acknowledged"
  | "replied"
  | "cancelled"
  | "expired"
  | "recipient-changed";
export type TaskCoordinationEndpointAvailability =
  "available" | "unassigned" | "inferred" | "terminal" | "missing-root";

export interface TaskCoordinationParticipant {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string;
}

export interface TaskCoordinationRecipient {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskStatus: DesktopTaskStatus;
  readonly intendedAgentId: string | null;
  readonly intendedAgentName: string | null;
  readonly deliveredSessionId: string | null;
  readonly deliveredAgentId: string | null;
  readonly deliveredAgentName: string | null;
  readonly ownershipCurrent: boolean;
  readonly principalCurrent: boolean;
}

export interface TaskCoordinationMessage {
  readonly schemaVersion: typeof TASK_COORDINATION_MESSAGE_SCHEMA_VERSION;
  readonly id: string;
  readonly ordinal: number;
  readonly recipientSequence: number;
  readonly senderSequence: number;
  readonly kind: TaskCoordinationKind;
  readonly sender: TaskCoordinationParticipant;
  readonly recipient: TaskCoordinationRecipient;
  readonly content: string;
  readonly correlationId: string;
  readonly replyToMessageId: string | null;
  readonly requiresAcknowledgement: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly repliedAt: string | null;
  readonly cancelledAt: string | null;
  readonly expiredAt: string | null;
  readonly deliveryState: TaskCoordinationDeliveryState;
}

export interface TaskCoordinationSourceInput {
  readonly sourceTaskId: string;
  readonly sourceSessionId: string;
  readonly sourceAgentId: string;
}

export interface SendTaskCoordinationMessageInput extends TaskCoordinationSourceInput {
  readonly targetTaskId: string;
  readonly kind?: TaskCoordinationKind;
  readonly content: string;
  readonly requiresAcknowledgement?: boolean;
  readonly expiresAt?: string | null;
  readonly idempotencyKey: string;
}

export interface SendTaskCoordinationMessageResult {
  readonly schemaVersion: "scr.task-coordination-send/v2";
  readonly created: boolean;
  readonly message: TaskCoordinationMessage;
}

export interface BroadcastTaskCoordinationMessageInput extends TaskCoordinationSourceInput {
  readonly targetTaskIds: readonly string[];
  readonly kind?: TaskCoordinationKind;
  readonly content: string;
  readonly requiresAcknowledgement?: boolean;
  readonly expiresAt?: string | null;
  readonly idempotencyKey: string;
}

export interface BroadcastTaskCoordinationMessageResult {
  readonly schemaVersion: "scr.task-coordination-broadcast/v2";
  readonly correlationId: string;
  readonly createdCount: number;
  readonly replayedCount: number;
  readonly messages: readonly TaskCoordinationMessage[];
}

export interface ReplyTaskCoordinationMessageInput extends TaskCoordinationSourceInput {
  readonly replyToMessageId: string;
  readonly kind?: TaskCoordinationKind;
  readonly content: string;
  readonly requiresAcknowledgement?: boolean;
  readonly expiresAt?: string | null;
  readonly idempotencyKey: string;
}

export interface TaskCoordinationMailboxInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface TaskCoordinationInboxInput extends TaskCoordinationMailboxInput {
  readonly pendingOnly?: boolean;
}

export interface TaskCoordinationInbox {
  readonly schemaVersion: typeof TASK_COORDINATION_INBOX_SCHEMA_VERSION;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly messages: readonly TaskCoordinationMessage[];
  readonly pendingCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly nextAfterSequence: number | null;
  readonly truncated: boolean;
}

export interface TaskCoordinationOperatorInboxInput {
  readonly taskId: string;
  readonly beforeSequence?: number;
  readonly limit?: number;
}

export interface TaskCoordinationOperatorInbox {
  readonly schemaVersion: typeof TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION;
  readonly taskId: string;
  readonly generatedAt: string;
  readonly messages: readonly TaskCoordinationMessage[];
  /** Live current-principal messages not yet read by an Agent, across all pages. */
  readonly unreadCount: number;
  /** Live messages awaiting an Agent read or required acknowledgement, across all pages. */
  readonly pendingCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly nextBeforeSequence: number | null;
  readonly truncated: boolean;
}

export interface TaskCoordinationOutboxInput extends TaskCoordinationMailboxInput {}

export interface TaskCoordinationOutbox {
  readonly schemaVersion: typeof TASK_COORDINATION_OUTBOX_SCHEMA_VERSION;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly messages: readonly TaskCoordinationMessage[];
  readonly pendingDeliveryOrAcknowledgementCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly nextAfterSequence: number | null;
  readonly truncated: boolean;
}

export interface TaskCoordinationThreadInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly correlationId: string;
  readonly afterOrdinal?: number;
  readonly limit?: number;
}

export interface TaskCoordinationThread {
  readonly schemaVersion: typeof TASK_COORDINATION_THREAD_SCHEMA_VERSION;
  readonly correlationId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly messages: readonly TaskCoordinationMessage[];
  readonly nextAfterOrdinal: number | null;
  readonly truncated: boolean;
}

export interface AcknowledgeTaskCoordinationMessageInput {
  readonly messageId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
}

export interface AcknowledgeTaskCoordinationMessageResult {
  readonly schemaVersion: "scr.task-coordination-acknowledge/v2";
  readonly changed: boolean;
  readonly message: TaskCoordinationMessage;
}

export interface AcknowledgeTaskCoordinationThroughInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly throughSequence: number;
}

export interface AcknowledgeTaskCoordinationThroughResult {
  readonly schemaVersion: "scr.task-coordination-acknowledge-through/v1";
  readonly changedCount: number;
  readonly throughSequence: number;
  readonly pendingCount: number;
}

export interface CancelTaskCoordinationMessageInput extends TaskCoordinationSourceInput {
  readonly messageId: string;
}

export interface CancelTaskCoordinationMessageResult {
  readonly schemaVersion: "scr.task-coordination-cancel/v1";
  readonly changed: boolean;
  readonly message: TaskCoordinationMessage;
}

export interface TaskCoordinationPendingInput {
  readonly agentId: string;
  readonly taskLimit?: number;
  readonly messageLimit?: number;
}

export interface TaskCoordinationPendingEntry {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskStatus: DesktopTaskStatus;
  readonly pendingCount: number;
  readonly oldestPendingAt: string;
  readonly newestPendingAt: string;
  readonly messages: readonly TaskCoordinationMessage[];
}

export interface TaskCoordinationPending {
  readonly schemaVersion: typeof TASK_COORDINATION_PENDING_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly totalPendingMessageCount: number;
  readonly totalTaskCount: number;
  readonly skippedTaskCount: number;
  readonly truncated: boolean;
  readonly entries: readonly TaskCoordinationPendingEntry[];
}

export interface TaskCoordinationDirectoryInput {
  readonly offset?: number;
  readonly limit?: number;
}

export interface TaskCoordinationDirectoryEntry {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskStatus: DesktopTaskStatus;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly availability: TaskCoordinationEndpointAvailability;
  readonly acceptsCoordination: boolean;
}

export interface TaskCoordinationDirectory {
  readonly schemaVersion: typeof TASK_COORDINATION_DIRECTORY_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly offset: number;
  readonly limit: number;
  readonly totalTaskCount: number;
  readonly skippedTaskCount: number;
  readonly nextOffset: number | null;
  readonly tasks: readonly TaskCoordinationDirectoryEntry[];
}
