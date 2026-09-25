import type { DesktopTaskMessage, DesktopTaskSummary } from "../shared.js";
import { taskBoardAgentPresence } from "./task-board-model.js";

export function renderTaskConversationDelivery(
  messages: readonly DesktopTaskMessage[],
  task: DesktopTaskSummary,
  timestamp: (value: string) => string,
  delivery: HTMLElement,
  help: HTMLElement,
): void {
  const latestUser = messages.findLast((message) => message.role === "user");
  const agentPresence = taskBoardAgentPresence(task);
  let tone = "stored";
  let text = "No Agent heartbeat yet";
  let helpText = "Messages stay local until this Agent starts checking Tasks Inbox.";
  let title = "";

  if (task.source === "inferred" || task.agent.id === null) {
    text = "No task Agent assigned · stored locally";
    helpText = "This task has no Agent owner yet. The message enters Tasks Inbox after an Agent claims it.";
  } else if (latestUser !== undefined && latestUser.acknowledgedAt !== null) {
    tone = "acknowledged";
    text = "Delivered to Agent";
    helpText = "The Agent acknowledged your latest instruction. Replies appear here automatically.";
    title = `Latest message acknowledged at ${timestamp(latestUser.acknowledgedAt)}.`;
  } else if (latestUser !== undefined) {
    tone = "pending";
    text = "Saved · waiting for Agent";
    helpText = agentPresence === "online"
      ? "Sovereign surfaces pending panel messages with the Agent's next tool result and through Tasks Inbox."
      : "The message stays local and enters Tasks Inbox when the Agent reconnects.";
  } else if (agentPresence === "online") {
    tone = "online";
    text = "Agent online";
    helpText = "New panel messages are surfaced with the Agent's next tool result and through Tasks Inbox.";
  } else if (agentPresence === "stale") {
    tone = "pending";
    text = "Agent heartbeat is stale";
    helpText = "Messages remain stored locally until the Agent checks in again.";
  } else if (agentPresence === "offline") {
    tone = "pending";
    text = "Agent offline · messages stay local";
    helpText = "Messages enter Tasks Inbox after the Agent reconnects.";
  }
  const className = `state-text task-conversation-delivery task-conversation-delivery-${tone}`;
  if (delivery.className !== className) delivery.className = className;
  if (delivery.textContent !== text) delivery.textContent = text;
  if (help.textContent !== helpText) help.textContent = helpText;
  if (title.length > 0) delivery.title = title;
  else delivery.removeAttribute("title");
}
