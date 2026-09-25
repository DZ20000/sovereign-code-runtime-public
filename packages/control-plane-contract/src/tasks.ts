export type DesktopTaskCategory =
  | "development"
  | "testing"
  | "build"
  | "research"
  | "maintenance"
  | "automation"
  | "other";

export type DesktopTaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting-user"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DesktopTaskSource = "agent" | "inferred" | "user";
export type DesktopTaskAgentPresence =
  "online" | "stale" | "offline" | "unknown";
export type DesktopTaskMessageRole = "user" | "assistant" | "system";
export type DesktopTaskStepStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface DesktopTaskProgress {
  readonly current: number | null;
  readonly total: number | null;
  readonly label: string | null;
}

export interface DesktopTaskStep {
  readonly id: string;
  readonly title: string;
  readonly status: DesktopTaskStepStatus;
  readonly updatedAt: string;
}

export interface DesktopTaskAgent {
  readonly id: string | null;
  readonly name: string | null;
  readonly principalId: string | null;
  readonly presence: DesktopTaskAgentPresence;
  readonly lastHeartbeatAt: string | null;
}

export interface DesktopTaskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly title: string;
  readonly category: DesktopTaskCategory;
  readonly status: DesktopTaskStatus;
  readonly source: DesktopTaskSource;
  readonly summary: string;
  readonly currentStep: string;
  readonly progress: DesktopTaskProgress;
  readonly steps: readonly DesktopTaskStep[];
  readonly agent: DesktopTaskAgent;
  readonly lastActivityLabel: string | null;
  readonly lastActivityAt: string | null;
  readonly unreadUserMessageCount: number;
  readonly coordinationPendingCount: number;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface DesktopTaskListAgent {
  readonly id: string | null;
  readonly name: string | null;
  readonly presence: DesktopTaskAgentPresence;
  readonly lastHeartbeatAt: string | null;
}

export interface DesktopTaskListItem {
  readonly id: string;
  readonly title: string;
  readonly category: DesktopTaskCategory;
  readonly status: DesktopTaskStatus;
  readonly source: DesktopTaskSource;
  readonly summaryPreview: string;
  readonly currentStep: string;
  readonly progress: DesktopTaskProgress;
  readonly agent: DesktopTaskListAgent;
  readonly lastActivityLabel: string | null;
  readonly lastActivityAt: string | null;
  readonly unreadUserMessageCount: number;
  readonly coordinationPendingCount: number;
  readonly messageCount: number;
  readonly updatedAt: string;
}

export type DesktopTaskProjectStatus =
  "active" | "attention" | "idle" | "completed";

export interface DesktopTaskProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly status: DesktopTaskProjectStatus;
  readonly taskCount: number;
  readonly activeTaskCount: number;
  readonly attentionTaskCount: number;
  readonly onlineAgentCount: number;
  readonly updatedAt: string;
  readonly tasks: readonly DesktopTaskListItem[];
}

export interface DesktopTaskWorkspaceSnapshot {
  readonly schemaVersion: "scr.task-workspace/v1";
  readonly generatedAt: string;
  readonly revision: number;
  readonly offset: number;
  readonly limit: number;
  readonly totalTaskCount: number;
  readonly totalProjectCount: number;
  readonly nextOffset: number | null;
  readonly projects: readonly DesktopTaskProjectSummary[];
}

export interface DesktopTaskMessage {
  readonly id: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly role: DesktopTaskMessageRole;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly content: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export interface DesktopTaskDetail {
  readonly task: DesktopTaskSummary;
  readonly messages: readonly DesktopTaskMessage[];
  readonly messagesTruncated: boolean;
  readonly oldestMessageSequence: number | null;
  readonly newestMessageSequence: number | null;
}

export interface DesktopTaskCreateInput {
  readonly projectRoot?: string;
  readonly projectName?: string;
  readonly title: string;
  readonly category?: DesktopTaskCategory;
  readonly summary?: string;
  readonly status?: DesktopTaskStatus;
  readonly currentStep?: string;
  readonly progressCurrent?: number | null;
  readonly progressTotal?: number | null;
  readonly progressLabel?: string | null;
  readonly steps?: readonly DesktopTaskStep[];
  readonly agentId?: string;
  readonly agentName?: string;
  readonly idempotencyKey?: string;
}

export interface DesktopTaskUpdateInput {
  readonly taskId: string;
  readonly title?: string;
  readonly category?: DesktopTaskCategory;
  readonly status?: DesktopTaskStatus;
  readonly summary?: string;
  readonly currentStep?: string;
  readonly progressCurrent?: number | null;
  readonly progressTotal?: number | null;
  readonly progressLabel?: string | null;
  readonly steps?: readonly DesktopTaskStep[];
  readonly agentId: string;
  readonly agentName?: string;
}

export interface DesktopTaskUnassignInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly agentName?: string;
}

export interface DesktopTaskClaimInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly expectedCurrentAgentId?: string | null;
}

export interface DesktopTaskHeartbeatInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly status?: Extract<
    DesktopTaskStatus,
    "planning" | "running" | "waiting-user" | "blocked"
  >;
  readonly currentStep?: string;
  readonly progressCurrent?: number | null;
  readonly progressTotal?: number | null;
  readonly progressLabel?: string | null;
  readonly acknowledgeThroughSequence?: number;
}

export interface DesktopTaskHeartbeatResult {
  readonly task: DesktopTaskSummary;
  readonly pendingUserMessages: readonly DesktopTaskMessage[];
}

export interface DesktopTaskInboxEntry {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly task: DesktopTaskListItem;
  readonly pendingUserMessages: readonly DesktopTaskMessage[];
}

export interface DesktopTaskInbox {
  readonly schemaVersion: "scr.task-inbox/v1";
  readonly generatedAt: string;
  readonly totalPendingUserMessageCount: number;
  readonly totalTaskCount: number;
  readonly truncated: boolean;
  readonly entries: readonly DesktopTaskInboxEntry[];
}

export interface DesktopTaskInboxInput {
  readonly taskLimit?: number;
  readonly messageLimit?: number;
}

export interface DesktopTaskMessageInput {
  readonly taskId: string;
  readonly content: string;
  readonly agentId: string;
  readonly agentName?: string;
}

export interface DesktopTaskMessageListInput {
  readonly taskId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}
