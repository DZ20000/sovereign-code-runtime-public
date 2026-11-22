import { ApprovalDecisionState } from "./approval-decision-state.js";
import type { UiLanguage } from "./localization.js";
import { applyTheme, type UiTheme } from "./ui-theme.js";

let theme: UiTheme = "system";
let language: UiLanguage = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
try {
  const settings: unknown = JSON.parse(localStorage.getItem("sovereign.ui.settings.v1") ?? "null");
  if (settings !== null && typeof settings === "object" && !Array.isArray(settings)) {
    const preferences = settings as Record<string, unknown>;
    if (preferences.language === "en" || preferences.language === "zh-CN") language = preferences.language;
    const fontScale = typeof preferences.fontScale === "number" && [1, 1.1, 1.2, 1.3].includes(preferences.fontScale) ? preferences.fontScale : 1;
    const uiScale = typeof preferences.uiScale === "number" && [1, 1.1, 1.25, 1.5].includes(preferences.uiScale) ? preferences.uiScale : 1;
    document.documentElement.style.fontSize = String(14 * fontScale * uiScale) + "px";
    document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion === true);
    if (preferences.theme === "dark" || preferences.theme === "light") theme = preferences.theme;
  }
} catch {
  // UI preferences cannot prevent a fail-closed approval decision.
}
applyTheme(theme);
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const followSystemTheme = () => { if (theme === "system") applyTheme(theme); };
systemTheme.addEventListener("change", followSystemTheme);
document.documentElement.lang = language;
const copy = (en: string, zh: string): string => language === "zh-CN" ? zh : en;

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (result === null) throw new Error("Missing approval element: " + id);
  return result as T;
}
const shell = document.querySelector<HTMLElement>(".approval-shell")!;
const title = element("approval-title");
const subtitle = element("approval-subtitle");
const status = element("approval-status");
const countdown = element("approval-countdown");
const allow = element<HTMLButtonElement>("approval-allow");
const deny = element<HTMLButtonElement>("approval-deny");
const drop = element<HTMLButtonElement>("approval-drop");
const close = element<HTMLButtonElement>("approval-close");
const back = element<HTMLButtonElement>("approval-return");
const feedback = element("approval-feedback");
let lastRenderKey = "";
let dismissalFailed = false;

function render(): void {
  const { current, phase } = state;
  const renderKey = JSON.stringify([current?.id, phase, state.remainingSeconds(), language, dismissalFailed]);
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  const context = current?.context;
  const handoff = context?.administratorRequired === true;
  const pending = phase === "pending";
  const inactive = phase === "expired" || phase === "uncertain" || phase === "unavailable";
  shell.dataset.phase = phase;
  shell.dataset.risk = handoff ? "handoff" : context?.destructive === true ? "destructive" : "normal";
  shell.classList.toggle("is-flood", current?.burstDetected === true);
  title.textContent = phase === "uncertain" ? copy("This decision is not confirmed", "这次决定尚未确认")
    : phase === "expired" ? copy("Request expired", "请求已过期")
      : phase === "unavailable" ? copy("Approval unavailable", "审批请求不可用")
        : phase === "loading" ? copy("Loading request…", "正在读取请求…")
          : handoff ? copy("Handle this step in Windows", "这一步需要你在 Windows 中处理")
            : context?.destructive ? copy("Allow this destructive action?", "允许这次破坏性操作？")
              : context?.target.kind === "command" ? copy("Allow this command?", "允许运行这条命令？")
                : copy("Allow this tool call?", "允许这次工具调用？");
  subtitle.textContent = handoff ? copy("Manual handoff · no background elevation", "人工接管 · 不在后台提权")
    : copy("Independent approval window · review this request", "独立审批窗口 · 请核对请求内容");
  status.textContent = phase === "loading" ? copy("Loading", "正在读取")
    : phase === "submitting" ? copy("Waiting for confirmation", "等待本次决定确认")
    : phase === "uncertain" ? copy("Needs checking", "需要检查")
      : phase === "expired" ? copy("Expired", "已过期")
        : phase === "unavailable" ? copy("Unavailable", "不可用")
          : handoff ? copy("Administrator rights required", "需要管理员权限")
            : current?.burstDetected ? copy("Repeated requests", "连续请求")
              : copy("Waiting for a decision", "等待决定");
  const seconds = state.remainingSeconds();
  const time = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  countdown.textContent = current === null ? "—" : (phase === "expired" ? time : copy("Remaining ", "剩余 ") + time);
  element("approval-requester").textContent = context?.requesterId ?? copy("Unknown requester", "请求方未知");
  element("approval-target").textContent = context?.target.value ?? current?.toolName ?? "—";
  element("approval-tool").textContent = current?.toolName ?? "—";
  element("approval-workspace").textContent = context?.workspaceId ? context.workspaceId + " · " : "";
  element("approval-detail").textContent = current?.detail ?? "";
  element("approval-detail-label").textContent = copy("Request details", "请求详情");
  const level = context === undefined ? "" : (context.permissionLevel === "consequential" ? "L3" : context.permissionLevel === "workspace" ? "L2" : "L1") + " · ";
  element("approval-message").textContent = phase === "uncertain"
    ? copy("Check the outcome before continuing.", "请先查看处理结果，再继续。")
    : phase === "unavailable" ? copy("This request is no longer available for approval.", "当前请求已无法审批。")
      : phase === "expired" ? copy("This request can no longer be approved.", "不能再批准这个请求。")
        : handoff ? copy("This window cannot grant administrator rights. Complete the required step in Windows, then check the task result.", "此审批窗口不能授予管理员权限。请在 Windows 中自行完成所需操作，再检查任务结果。")
          : level + copy("This permission covers exactly one tool call.", "本次授权只覆盖这一条工具调用。");
  element("approval-guidance").textContent = phase === "uncertain"
    ? copy("Approval controls are disabled. This request will not be retried.", "当前请求的批准按钮已停用，不会自动重试。")
    : handoff ? copy("Nothing runs automatically. Manual handoff closes and denies this request.", "此处不会自动运行命令或提权。手动接管会关闭并拒绝本次请求。")
      : copy("Denying or closing this window does not grant permission.", "拒绝或关闭窗口，将不会授予这次调用权限。");
  allow.textContent = handoff ? copy("I'll handle this manually", "我会手动处理")
    : phase === "submitting" ? copy("Submitting…", "提交中…") : copy("Allow once", "仅允许一次");
  deny.textContent = inactive ? copy("Close", "关闭") : handoff ? copy("Deny and close", "拒绝并关闭") : copy("Deny", "拒绝");
  drop.textContent = copy("Deny all & drop to L1", "全部拒绝并降至 L1");
  close.setAttribute("aria-label", copy("Close", "关闭"));
  back.textContent = copy("Return to approval center", "返回审批中心");
  allow.hidden = inactive;
  allow.disabled = !pending;
  deny.disabled = phase === "loading" || phase === "submitting";
  close.disabled = phase === "submitting";
  drop.hidden = current?.burstDetected !== true || inactive;
  drop.disabled = !pending;
  back.hidden = phase !== "uncertain" && phase !== "unavailable";
  if (dismissalFailed) feedback.textContent = copy("Could not close this window. Use the window close control.", "暂时无法关闭，请使用系统窗口关闭按钮。");
  else if (phase === "submitting") feedback.textContent = copy("Submitting this decision…", "正在提交本次决定…");
  else if (phase === "uncertain") feedback.textContent = copy("The decision was not acknowledged. No decision is sent again.", "尚未收到决定确认，不会再次发送决定。");
  else feedback.textContent = "";
}
const state = new ApprovalDecisionState(window.sovereignApproval, render);
async function dismiss(returnToCenter = false): Promise<void> {
  try { await window.sovereignApproval.dismiss(returnToCenter); }
  catch { dismissalFailed = true; render(); }
}
allow.addEventListener("click", () => {
  void state.decide(state.current?.context?.administratorRequired === true ? "deny" : "allow-once");
});
deny.addEventListener("click", () => {
  if (state.phase === "pending") void state.decide("deny");
  else if (state.phase !== "submitting") void dismiss(state.phase === "expired");
});
drop.addEventListener("click", () => { void state.decide("drop-to-l1"); });
close.addEventListener("click", () => { void dismiss(); });
back.addEventListener("click", () => { void dismiss(true); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.phase !== "submitting") {
    event.preventDefault();
    void dismiss();
  }
});
const timer = window.setInterval(() => state.tick(), 250);
window.addEventListener("beforeunload", () => {
  window.clearInterval(timer);
  systemTheme.removeEventListener("change", followSystemTheme);
}, { once: true });
void state.load().then(() => { if (state.phase === "pending") deny.focus(); });
