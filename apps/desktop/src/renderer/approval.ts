import type {
  DesktopApprovalDecision,
  DesktopApprovalView,
} from "../shared.js";
import { localizeSubtree, observeLocalization, type UiLanguage } from "./localization.js";

let language: UiLanguage = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
try {
  const settings: unknown = JSON.parse(localStorage.getItem("sovereign.ui.settings.v1") ?? "null");
  if (settings !== null && typeof settings === "object" && !Array.isArray(settings)) {
    const preferences = settings as Record<string, unknown>;
    if (preferences.language === "en" || preferences.language === "zh-CN") language = preferences.language;
    const fontScale = typeof preferences.fontScale === "number" && [1, 1.1, 1.2, 1.3].includes(preferences.fontScale) ? preferences.fontScale : 1;
    const uiScale = typeof preferences.uiScale === "number" && [1, 1.1, 1.25, 1.5].includes(preferences.uiScale) ? preferences.uiScale : 1;
    document.documentElement.style.fontSize = `${14 * fontScale * uiScale}px`;
    document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion === true);
  }
} catch {
  // Unavailable or malformed UI preferences do not block an approval decision.
}
localizeSubtree(document.body, language);
const stopLocalization = observeLocalization(document.body, () => language);

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing approval element: ${selector}`);
  }
  return element;
}

const shell = requiredElement<HTMLElement>(".approval-shell");
const title = requiredElement<HTMLElement>("#approval-title");
const message = requiredElement<HTMLElement>("#approval-message");
const tool = requiredElement<HTMLElement>("#approval-tool");
const detail = requiredElement<HTMLElement>("#approval-detail");
const countdown = requiredElement<HTMLElement>("#approval-countdown");
const allowButton = requiredElement<HTMLButtonElement>("#approval-allow");
const denyButton = requiredElement<HTMLButtonElement>("#approval-deny");
const dropButton = requiredElement<HTMLButtonElement>("#approval-drop");
const feedback = requiredElement<HTMLElement>("#approval-feedback");

let current: DesktopApprovalView | null = null;
let timer: number | null = null;
let resolving = false;
let expired = false;

function setButtonsDisabled(disabled: boolean): void {
  allowButton.disabled = disabled;
  denyButton.disabled = disabled;
  dropButton.disabled = disabled;
}

function renderCountdown(): void {
  if (current === null) {
    countdown.textContent = "—";
    return;
  }
  const remainingMs = Date.parse(current.expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    countdown.textContent = language === "zh-CN" ? "已过期" : "Expired";
    if (!expired) feedback.textContent = "This request has expired. Ask the Agent to try again.";
    expired = true;
    setButtonsDisabled(true);
    return;
  }
  const seconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  countdown.textContent = language === "zh-CN" ? `剩余 ${seconds} 秒` : `${seconds}s remaining`;
}

function renderApproval(approval: DesktopApprovalView): void {
  current = approval;
  title.textContent = approval.burstDetected ? "Approval flood detected" : approval.title;
  message.textContent = approval.burstDetected
    ? "Multiple consequential requests arrived within 10 seconds. Review this request or drop connected authority to L1."
    : approval.message;
  tool.textContent = approval.toolName;
  detail.textContent = approval.detail;
  shell.classList.toggle("is-flood", approval.burstDetected);
  dropButton.hidden = !approval.burstDetected;
  setButtonsDisabled(false);
  renderCountdown();
  denyButton.focus();
  timer = window.setInterval(renderCountdown, 250);
}

async function resolve(decision: DesktopApprovalDecision): Promise<void> {
  if (current === null || resolving) {
    return;
  }
  resolving = true;
  setButtonsDisabled(true);
  feedback.classList.remove("is-error");
  feedback.textContent = "Resolving request…";
  try {
    await window.sovereignApproval.resolve(current.id, decision);
  } catch {
    resolving = false;
    setButtonsDisabled(false);
    feedback.classList.add("is-error");
    feedback.textContent = "Could not submit your decision. Try again while the request is still pending.";
    renderCountdown();
  }
}

allowButton.addEventListener("click", () => {
  void resolve("allow-once");
});
denyButton.addEventListener("click", () => {
  void resolve("deny");
});
dropButton.addEventListener("click", () => {
  void resolve("drop-to-l1");
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    void resolve("deny");
  }
});
window.addEventListener("beforeunload", () => {
  stopLocalization();
  if (timer !== null) {
    window.clearInterval(timer);
  }
}, { once: true });

void window.sovereignApproval.getCurrent().then((approval) => {
  if (approval === null) {
    title.textContent = "Approval unavailable";
    message.textContent = "This request is no longer pending.";
    tool.textContent = "—";
    countdown.textContent = language === "zh-CN" ? "已过期" : "Expired";
    setButtonsDisabled(true);
    return;
  }
  renderApproval(approval);
}).catch(() => {
  title.textContent = "Approval unavailable";
  message.textContent = "Could not load this request. Ask the Agent to try again.";
  tool.textContent = "—";
  countdown.textContent = "—";
  setButtonsDisabled(true);
});
