import type { DesktopAuditReceipt, DesktopPendingApproval, SovereignDesktopApi } from "../shared.js";
import type { UiLanguage } from "./localization.js";

type ApprovalTab = "approvals" | "audit";
interface Options {
  readonly api: Pick<SovereignDesktopApi, "getApprovals" | "openApproval" | "getAuditReceipts">;
  readonly getLanguage?: () => UiLanguage;
  readonly notify?: (message: string) => void;
  readonly onPendingCount?: (count: number | null) => void;
}

export function createApprovalsAuditController(options: Options) {
  function el<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (value === null) throw new Error("Missing approval center element: " + id);
    return value as T;
  }
  const language = (): UiLanguage => options.getLanguage?.() ?? (document.documentElement.lang === "zh-CN" ? "zh-CN" : "en");
  const copy = (en: string, zh: string): string => language() === "zh-CN" ? zh : en;
  const scope = el("v2-approvals-audit");
  const pendingTab = el<HTMLButtonElement>("v2-approvals-tab-pending");
  const auditTab = el<HTMLButtonElement>("v2-approvals-tab-audit");
  const list = el<HTMLUListElement>("v2-approvals-list");
  const auditList = el<HTMLUListElement>("v2-audit-list");
  const search = el<HTMLInputElement>("v2-audit-search");
  const outcome = el<HTMLSelectElement>("v2-audit-outcome");
  const feedback = el("v2-approvals-feedback");
  const events = new AbortController();
  let tab: ApprovalTab = "approvals";
  let approvals: readonly DesktopPendingApproval[] = [];
  let receipts: readonly DesktopAuditReceipt[] = [];
  let selectedReceipt: string | null = null;
  let loadedAudit = false;
  let disposed = false;
  let refreshPromise: Promise<void> | null = null;
  let opening: string | null = null;
  let approvalsAvailable: boolean | null = null;
  let feedbackKind: "read" | "action" | null = null;
  scope.dataset.noI18n = "";

  function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = value;
    return node;
  }
  function setFeedback(value: string, kind: "read" | "action" = "read"): void {
    feedbackKind = value === "" ? null : kind;
    feedback.textContent = value;
    if (value !== "") options.notify?.(value);
  }
  function remaining(expiresAt: string): string {
    const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000));
    if (!Number.isFinite(seconds) || seconds === 0) return copy("Expired", "已过期");
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }
  function updateCountdowns(): void {
    for (const node of list.querySelectorAll<HTMLElement>("[data-expires-at]")) {
      node.textContent = remaining(node.dataset.expiresAt ?? "");
    }
    for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-request-id]")) {
      const request = approvals.find((entry) => entry.id === button.dataset.requestId);
      button.disabled = request === undefined || request.phase !== "active" || Date.parse(request.expiresAt) <= Date.now() || opening !== null;
    }
    const count = approvals.filter((entry) => Date.parse(entry.expiresAt) > Date.now()).length;
    el("v2-approvals-count").textContent = count > 0 ? " · " + count : "";
  }
  async function open(request: DesktopPendingApproval): Promise<void> {
    if (opening !== null || request.phase !== "active" || Date.parse(request.expiresAt) <= Date.now()) return;
    opening = request.id;
    updateCountdowns();
    try {
      const result = await options.api.openApproval(request.id);
      if (disposed) return;
      if (result === "queued") setFeedback(copy("This request is waiting for the active decision.", "此请求正在等待前序审批完成。"), "action");
      else if (result === "unavailable") setFeedback(copy("A trusted approval window is unavailable for this request. Refresh the list.", "暂时无法打开此请求的可信审批窗口，请刷新列表。"), "action");
    } catch {
      if (!disposed) setFeedback(copy("Could not open the trusted approval window.", "暂时无法打开可信审批窗口。"), "action");
    } finally {
      opening = null;
      if (!disposed) void refresh();
    }
  }
  function renderApprovals(): void {
    list.replaceChildren();
    for (const request of approvals) {
      const context = request.context;
      const row = text("li", "v2-approval-row", "");
      row.dataset.phase = request.phase;
      row.dataset.risk = context?.administratorRequired === true ? "handoff" : context?.destructive === true ? "destructive" : "normal";
      const facts = text("div", "v2-approval-facts", "");
      const requester = text("p", "v2-requester", context?.requesterId ?? copy("Unknown requester", "请求方未知"));
      const target = text("p", "v2-target", context?.target.value ?? request.toolName);
      requester.dataset.noI18n = "";
      target.dataset.noI18n = "";
      facts.append(requester, target);
      if (context?.workspaceId) facts.append(text("p", "v2-muted", context.workspaceId));
      const meta = text("div", "v2-approval-meta", "");
      const level = context === undefined ? "" : context.permissionLevel === "consequential" ? "L3" : context.permissionLevel === "workspace" ? "L2" : "L1";
      meta.append(text("span", "v2-muted", context?.administratorRequired === true ? copy("Manual handoff", "需要人工接管") : level + (context?.destructive ? copy(" · Destructive", " · 破坏性") : "")));
      const countdown = text("span", "v2-muted", remaining(request.expiresAt));
      countdown.dataset.expiresAt = request.expiresAt;
      meta.append(countdown);
      const button = text("button", "button button-ghost v2-approval-open", request.phase === "queued" ? copy("Queued", "排队中") : copy("View and decide", "查看并处理"));
      button.type = "button";
      button.dataset.requestId = request.id;
      row.append(facts, meta, button);
      list.append(row);
    }
    if (approvals.length === 0) list.append(text("li", "v2-empty", approvalsAvailable === null
      ? copy("Loading approvals…", "正在读取审批请求…") : approvalsAvailable
        ? copy("No pending approvals.", "暂无待审批请求。") : copy("Pending approvals are unavailable.", "待审批请求暂时不可用。")));
    updateCountdowns();
  }
  function outcomeText(value: string): string {
    return value === "succeeded" ? copy("Succeeded", "成功") : value === "denied" ? copy("Denied", "已拒绝") : value === "failed" ? copy("Failed", "失败") : value;
  }
  function renderDetail(): void {
    const record = receipts.find((entry) => entry.id === selectedReceipt);
    const detail = el("v2-audit-detail");
    detail.hidden = record === undefined;
    const content = el("v2-audit-detail-content");
    content.replaceChildren();
    if (record === undefined) return;
    content.append(text("p", "v2-muted", copy("Operation receipt · ", "操作回执 · ") + record.id));
    content.append(text("p", "v2-status", outcomeText(record.outcome)));
    content.append(text("p", "v2-target", record.relativePath ?? record.operation));
    content.append(text("p", "v2-secondary", record.toolName + " · " + record.operation));
    const facts = text("dl", "v2-audit-facts", "");
    const values: readonly [string, string | null][] = [
      [copy("Requester ID", "调用方 ID"), record.principalId],
      [copy("Workspace", "工作区"), record.workspaceId],
      [copy("Time", "时间"), record.occurredAt],
      [copy("Before SHA-256", "修改前 SHA-256"), record.beforeSha256],
      [copy("After SHA-256", "修改后 SHA-256"), record.afterSha256],
      [copy("Error code", "错误码"), record.errorCode],
    ];
    for (const [label, value] of values) {
      if (value === null) continue;
      const row = text("div", "v2-audit-fact", "");
      const data = text("dd", "v2-audit-value", value);
      data.dataset.noI18n = "";
      row.append(text("dt", "v2-muted", label), data);
      facts.append(row);
    }
    content.append(facts);
  }
  function renderAudit(): void {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = receipts.filter((record) =>
      (outcome.value === "all" || record.outcome === outcome.value) &&
      [record.toolName, record.operation, record.relativePath ?? ""].join(" ").toLocaleLowerCase().includes(query));
    if (selectedReceipt !== null && !filtered.some((record) => record.id === selectedReceipt)) selectedReceipt = null;
    auditList.replaceChildren();
    for (const record of filtered) {
      const row = text("li", "", "");
      const button = text("button", "v2-audit-row", "");
      button.type = "button";
      button.dataset.receiptId = record.id;
      button.setAttribute("aria-pressed", String(record.id === selectedReceipt));
      button.dataset.selected = String(record.id === selectedReceipt);
      const primary = text("div", "v2-audit-row-primary", "");
      primary.append(text("span", "v2-target", record.relativePath ?? record.operation), text("span", "v2-muted", outcomeText(record.outcome)));
      const time = new Date(record.occurredAt);
      const stamp = Number.isNaN(time.getTime()) ? record.occurredAt : time.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
      button.append(primary, text("span", "v2-secondary", stamp + " · " + record.toolName + " · " + record.operation));
      row.append(button);
      auditList.append(row);
    }
    if (filtered.length === 0) auditList.append(text("li", "v2-empty", copy("No matching receipts.", "暂无匹配记录。")));
    el("v2-audit-count").textContent = String(filtered.length) + copy(" records", " 条记录");
    renderDetail();
  }
  function refreshLabels(): void {
    const labels: readonly [string, string, string][] = [
      ["v2-approvals-heading", "Waiting for a decision", "等待处理"],
      ["v2-approvals-guidance", "Check the requester and target, then decide in the independent approval window.", "先核对请求方和目标，再在独立审批窗口中决定。"],
      ["v2-approvals-context-label", "Requester and target", "请求方与目标"],
      ["v2-approvals-time-label", "Permission / remaining", "权限 / 剩余时间"],
      ["v2-approvals-note", "Requests keep their original deadlines. Queued requests wait for the active decision.", "请求到期后自动失效；排队请求等待前序审批完成。"],
      ["v2-audit-search-label", "Search records", "搜索记录"],
      ["v2-audit-outcome-label", "Outcome", "结果"],
      ["v2-audit-heading", "Recent records", "最近记录"],
      ["v2-audit-detail-heading", "Audit details", "审计详情"],
      ["v2-audit-note", "Search and filters apply to the loaded operation receipts.", "按工具、操作、路径与结果查看当前已加载的操作回执。"],
    ];
    for (const [id, en, zh] of labels) el(id).textContent = copy(en, zh);
    pendingTab.firstChild!.textContent = copy("Pending", "待审批");
    auditTab.textContent = copy("Audit", "审计");
    for (const id of ["v2-approvals-refresh", "v2-audit-refresh"]) el(id).textContent = copy("Refresh", "刷新");
    search.placeholder = copy("Search by tool, operation or path", "按工具、操作或路径查找");
    el("v2-audit-close").setAttribute("aria-label", copy("Close details", "关闭详情"));
    for (const option of outcome.options) option.textContent = option.value === "all" ? copy("All outcomes", "结果：全部") : outcomeText(option.value);
    renderApprovals();
    renderAudit();
  }
  async function refresh(): Promise<void> {
    if (disposed) return;
    if (refreshPromise !== null) return await refreshPromise;
    refreshPromise = (async () => {
      const results = await Promise.allSettled([options.api.getApprovals(), options.api.getAuditReceipts(100)]);
      if (disposed) return;
      const [pending, audit] = results;
      if (pending.status === "fulfilled") {
        approvals = pending.value;
        approvalsAvailable = true;
        options.onPendingCount?.(approvals.length);
      } else {
        approvals = [];
        approvalsAvailable = false;
        options.onPendingCount?.(null);
        setFeedback(copy("Pending approvals are unavailable. Refresh to try reading them again.", "暂时无法读取待审批请求，请刷新重读。"));
      }
      if (audit.status === "fulfilled") {
        receipts = audit.value;
        if (!loadedAudit) selectedReceipt = receipts[0]?.id ?? null;
        loadedAudit = true;
      } else setFeedback(copy("Could not refresh operation receipts.", "暂时无法刷新操作回执。"));
      if (pending.status === "fulfilled" && audit.status === "fulfilled" && feedbackKind === "read") setFeedback("");
      refreshLabels();
    })().finally(() => { refreshPromise = null; });
    return await refreshPromise;
  }
  function activate(next: ApprovalTab = tab): void {
    tab = next;
    pendingTab.setAttribute("aria-selected", String(tab === "approvals"));
    auditTab.setAttribute("aria-selected", String(tab === "audit"));
    pendingTab.tabIndex = tab === "approvals" ? 0 : -1;
    auditTab.tabIndex = tab === "audit" ? 0 : -1;
    el("v2-approvals-pending").hidden = tab !== "approvals";
    el("v2-approvals-audit-pane").hidden = tab !== "audit";
    refreshLabels();
  }
  list.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-request-id]") : null;
    const request = approvals.find((entry) => entry.id === button?.dataset.requestId);
    if (request !== undefined) void open(request);
  }, { signal: events.signal });
  auditList.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-receipt-id]") : null;
    if (button === null) return;
    selectedReceipt = button.dataset.receiptId ?? null;
    renderAudit();
    el("v2-audit-detail-heading").focus();
  }, { signal: events.signal });
  pendingTab.addEventListener("click", () => { activate("approvals"); void refresh(); }, { signal: events.signal });
  auditTab.addEventListener("click", () => { activate("audit"); void refresh(); }, { signal: events.signal });
  scope.querySelector(".v2-tabs")!.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
    event.preventDefault();
    activate(key === "Home" ? "approvals" : key === "End" ? "audit" : tab === "audit" ? "approvals" : "audit");
    (tab === "audit" ? auditTab : pendingTab).focus();
    void refresh();
  }, { signal: events.signal });
  for (const id of ["v2-approvals-refresh", "v2-audit-refresh"]) el(id).addEventListener("click", () => { void refresh(); }, { signal: events.signal });
  search.addEventListener("input", renderAudit, { signal: events.signal });
  outcome.addEventListener("change", renderAudit, { signal: events.signal });
  el("v2-audit-close").addEventListener("click", () => { selectedReceipt = null; renderAudit(); search.focus(); }, { signal: events.signal });
  const timer = window.setInterval(updateCountdowns, 1_000);
  activate();
  return { refresh, activate, refreshLabels, dispose: () => { disposed = true; events.abort(); window.clearInterval(timer); } };
}
