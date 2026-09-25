import type {
  DesktopTaskAgentPresence,
  DesktopTaskDetail,
  DesktopTaskStatus,
} from "../shared.js";
import { taskBoardAgentPresence } from "./task-board-model.js";

export type TaskSessionContinuityLanguage = "en" | "zh-CN";
export type TaskSessionContinuityTone =
  | "connected"
  | "handoff"
  | "attention"
  | "complete"
  | "unassigned"
  | "captured";

export interface TaskSessionContinuityModel {
  readonly tone: TaskSessionContinuityTone;
  readonly kicker: string;
  readonly title: string;
  readonly stateLabel: string;
  readonly detail: string;
  readonly ownerCaption: string;
  readonly ownerLabel: string;
  readonly conversationCaption: string;
  readonly conversationLabel: string;
  readonly nextCaption: string;
  readonly nextLabel: string;
}

const ACTIVE_STATUSES = new Set<DesktopTaskStatus>([
  "queued",
  "planning",
  "running",
]);
const ATTENTION_STATUSES = new Set<DesktopTaskStatus>([
  "waiting-user",
  "blocked",
  "failed",
]);
const COMPLETE_STATUSES = new Set<DesktopTaskStatus>([
  "succeeded",
  "cancelled",
]);

const PRESENCE_LABELS: Readonly<
  Record<DesktopTaskAgentPresence, { readonly en: string; readonly zh: string }>
> = {
  online: { en: "online", zh: "在线" },
  stale: { en: "heartbeat stale", zh: "心跳已过期" },
  offline: { en: "offline", zh: "离线" },
  unknown: { en: "not checked in", zh: "尚未签到" },
};

function messageLabel(
  detail: DesktopTaskDetail,
  language: TaskSessionContinuityLanguage,
): string {
  const total = Math.max(detail.task.messageCount, detail.messages.length);
  if (total === 0) {
    return language === "zh-CN"
      ? "没有已保存的任务消息"
      : "No saved task messages";
  }
  return language === "zh-CN"
    ? `已保存 ${total} 条任务消息`
    : `${total} saved task message${total === 1 ? "" : "s"}`;
}

function ownerLabel(
  detail: DesktopTaskDetail,
  language: TaskSessionContinuityLanguage,
): string {
  const { task } = detail;
  if (task.source === "inferred") {
    return language === "zh-CN" ? "没有 Agent 所有者" : "No Agent owner";
  }
  if (task.agent.id === null) {
    return language === "zh-CN" ? "尚未分配" : "Unassigned";
  }
  const presence = PRESENCE_LABELS[taskBoardAgentPresence(task)];
  return `${task.agent.name ?? (language === "zh-CN" ? "任务 Agent" : "Task Agent")} · ${
    language === "zh-CN" ? presence.zh : presence.en
  }`;
}

function commonLabels(language: TaskSessionContinuityLanguage) {
  return language === "zh-CN"
    ? {
        kicker: "网页会话连续性",
        ownerCaption: "任务所有者",
        conversationCaption: "已保存的对话",
        nextCaption: "下一网页会话",
      }
    : {
        kicker: "Web session continuity",
        ownerCaption: "Task owner",
        conversationCaption: "Saved conversation",
        nextCaption: "Next web session",
      };
}

export function buildTaskSessionContinuity(
  detail: DesktopTaskDetail,
  language: TaskSessionContinuityLanguage,
): TaskSessionContinuityModel {
  const labels = commonLabels(language);
  const { task } = detail;
  const owner = ownerLabel(detail, language);
  const conversation = messageLabel(detail, language);

  if (task.source === "inferred") {
    return {
      ...labels,
      tone: "captured",
      title:
        language === "zh-CN"
          ? "捕获的活动尚不是网页会话"
          : "Captured activity is not a web session",
      stateLabel: language === "zh-CN" ? "等待认领" : "Awaiting claim",
      detail:
        language === "zh-CN"
          ? "Sovereign 已保存这段工具活动，但在 Agent 认领任务前，不会把它描述为可接续的网页会话。"
          : "Sovereign saved this tool activity, but it is not described as a resumable web session until an Agent claims the Task.",
      ownerLabel: owner,
      conversationLabel: conversation,
      nextLabel:
        language === "zh-CN"
          ? "先由 Agent 认领此任务，再把它作为后续网页会话的接续点。"
          : "Have an Agent claim this Task before using it as a handoff point for another web conversation.",
    };
  }

  if (COMPLETE_STATUSES.has(task.status)) {
    return {
      ...labels,
      tone: "complete",
      title:
        language === "zh-CN" ? "任务历史已保留" : "Task history is retained",
      stateLabel: language === "zh-CN" ? "已完成" : "Completed",
      detail:
        language === "zh-CN"
          ? "任务已经结束；已保存的任务消息仍可作为本地历史查看，但不会继续执行。"
          : "The Task has ended. Its saved messages remain available as local history, but no live continuation is expected.",
      ownerLabel: owner,
      conversationLabel: conversation,
      nextLabel:
        language === "zh-CN"
          ? "可从任何网页会话重新打开此任务查看历史；不会自动复制浏览器对话记忆。"
          : "Any web conversation may reopen this Task to review its history; browser conversation memory is not copied automatically.",
    };
  }

  if (ATTENTION_STATUSES.has(task.status)) {
    return {
      ...labels,
      tone: "attention",
      title:
        language === "zh-CN" ? "继续前需要处理" : "Review before continuing",
      stateLabel:
        task.status === "waiting-user"
          ? language === "zh-CN"
            ? "等待你"
            : "Waiting for you"
          : task.status === "blocked"
            ? language === "zh-CN"
              ? "已受阻"
              : "Blocked"
            : language === "zh-CN"
              ? "失败"
              : "Failed",
      detail:
        language === "zh-CN"
          ? "任务状态和消息已经保留，但需要先解决当前问题或给出决定，后续网页会话才应继续执行。"
          : "Task state and messages are preserved, but the current issue or operator decision should be resolved before another web conversation continues execution.",
      ownerLabel: owner,
      conversationLabel: conversation,
      nextLabel:
        language === "zh-CN"
          ? "在新的网页会话中打开同一任务并处理待办；Sovereign 不会自动迁移浏览器对话内容。"
          : "Open the same Task from the replacement web conversation and resolve the pending item; Sovereign does not transfer the browser transcript automatically.",
    };
  }

  if (task.agent.id === null) {
    return {
      ...labels,
      tone: "unassigned",
      title:
        language === "zh-CN"
          ? "分配 Agent 后才能接续"
          : "Assign an Agent to continue",
      stateLabel: language === "zh-CN" ? "尚未分配" : "Unassigned",
      detail:
        language === "zh-CN"
          ? "任务和消息已保存在 Sovereign 中，但当前没有 Agent 所有者，因此不能把它视为正在接续的网页工作。"
          : "The Task and messages are stored in Sovereign, but no Agent owns the work, so it is not yet a live web-session continuation.",
      ownerLabel: owner,
      conversationLabel: conversation,
      nextLabel:
        language === "zh-CN"
          ? "先让 Agent 加入或接管此任务，再从替代网页会话继续。"
          : "Join or assign an Agent to this Task before continuing from a replacement web conversation.",
    };
  }

  if (ACTIVE_STATUSES.has(task.status) && taskBoardAgentPresence(task) === "online") {
    return {
      ...labels,
      tone: "connected",
      title:
        language === "zh-CN"
          ? "任务上下文可继续"
          : "Task context is ready to continue",
      stateLabel: language === "zh-CN" ? "Agent 在线" : "Agent online",
      detail:
        language === "zh-CN"
          ? "任务状态和已保存消息属于 Sovereign 的共享任务范围；替代网页会话可以重新打开此任务继续工作。"
          : "Task state and saved messages belong to Sovereign's shared Task scope. A replacement web conversation can reopen this Task and continue the work.",
      ownerLabel: owner,
      conversationLabel: conversation,
      nextLabel:
        language === "zh-CN"
          ? "在替代网页会话中打开同一任务。浏览器对话记忆不会自动复制，接续依据是已保存的任务状态和消息。"
          : "Open this same Task from the replacement web conversation. Browser memory is not copied; continuity comes from saved Task state and messages.",
    };
  }

  return {
    ...labels,
    tone: "handoff",
    title:
      language === "zh-CN" ? "任务上下文已保留" : "Task context is preserved",
    stateLabel: language === "zh-CN" ? "可交接" : "Handoff ready",
    detail:
      language === "zh-CN"
        ? "Agent 当前未在线，但任务状态和消息仍保存在本地。重新连接或分配 Agent 后可以从同一任务继续。"
        : "The Agent is not currently online, but Task state and messages remain stored locally. Reconnect or assign an Agent to continue from the same Task.",
    ownerLabel: owner,
    conversationLabel: conversation,
    nextLabel:
      language === "zh-CN"
        ? "在替代网页会话中重新打开同一任务；不会自动迁移浏览器对话内容。"
        : "Reopen this same Task from the replacement web conversation; the browser transcript is not transferred automatically.",
  };
}
