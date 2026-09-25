import type { DesktopTaskDetail } from "../shared.js";
import { buildTaskSessionContinuity } from "./task-session-continuity.js";

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Task continuity element is missing: ${selector}`);
  }
  return element;
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export function renderTaskSessionContinuity(detail: DesktopTaskDetail): void {
  const language = document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
  const model = buildTaskSessionContinuity(detail, language);
  const root = requiredElement<HTMLElement>("#task-session-continuity");
  const className = `task-detail-card task-session-continuity-card task-session-continuity-${model.tone}`;
  if (root.className !== className) root.className = className;
  root.dataset.continuityTone = model.tone;
  root.hidden = false;

  setText(
    requiredElement<HTMLElement>("#task-session-continuity-kicker"),
    model.kicker,
  );
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-title"),
    model.title,
  );
  const state = requiredElement<HTMLElement>("#task-session-continuity-state");
  const stateClass = `task-session-continuity-state task-session-continuity-state-${model.tone}`;
  if (state.className !== stateClass) state.className = stateClass;
  setText(state, model.stateLabel);
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-detail"),
    model.detail,
  );
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-owner-caption"),
    model.ownerCaption,
  );
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-owner"),
    model.ownerLabel,
  );
  setText(
    requiredElement<HTMLElement>(
      "#task-session-continuity-conversation-caption",
    ),
    model.conversationCaption,
  );
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-conversation"),
    model.conversationLabel,
  );
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-next-caption"),
    model.nextCaption,
  );
  setText(
    requiredElement<HTMLElement>("#task-session-continuity-next"),
    model.nextLabel,
  );
}
