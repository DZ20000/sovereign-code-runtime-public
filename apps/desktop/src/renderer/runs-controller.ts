import type {
  DesktopRunRecord,
  DesktopRunState,
  DesktopRunSummary,
  SovereignDesktopApi,
} from "../shared.js";
import { runTaskId, runsInTaskScope } from "./task-run-scope.js";

interface RunsControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "getRuns" | "getRun" | "cancelRun">;
  readonly notify: (message: string, isError?: boolean) => void;
  readonly onSummariesChanged?: (summaries: readonly DesktopRunSummary[]) => void;
  readonly onActiveRunChanged?: (
    run: DesktopRunRecord | null,
    activeCount: number,
  ) => void;
}

const ACTIVE_STATES = new Set<DesktopRunState>(["queued", "running"]);

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Runs UI element is missing: ${selector}`);
  }
  return element;
}

function currentLocale(): string {
  return document.documentElement.lang === "zh-CN" ? "zh-CN" : "en-US";
}

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function effectiveDuration(run: Pick<DesktopRunRecord, "durationMs" | "startedAt">): number | null {
  if (run.durationMs !== null) {
    return run.durationMs;
  }
  if (run.startedAt === null) {
    return null;
  }
  const startedAt = Date.parse(run.startedAt);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (value < 1_000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`;
  }
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1_000);
    return `${minutes}m ${seconds}s`;
  }
  if (value < 86_400_000) {
    const hours = Math.floor(value / 3_600_000);
    const minutes = Math.floor((value % 3_600_000) / 60_000);
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(value / 86_400_000);
  const hours = Math.floor((value % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h`;
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KiB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function stateLabel(state: DesktopRunState, cancelRequested: boolean): string {
  if (cancelRequested && ACTIVE_STATES.has(state)) {
    return "cancelling";
  }
  return state;
}

function outputBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function renderOutputText(element: HTMLElement, value: string, emptyText: string): void {
  if (value.length === 0) {
    element.dataset.i18nPlaceholder = "";
    element.textContent = emptyText;
    return;
  }
  delete element.dataset.i18nPlaceholder;
  element.textContent = value;
}

function localText(english: string, chinese: string): string {
  return currentLocale() === "zh-CN" ? chinese : english;
}

export class RunsController {
  readonly #api: RunsControllerOptions["api"];
  readonly #notify: RunsControllerOptions["notify"];
  readonly #onSummariesChanged: RunsControllerOptions["onSummariesChanged"];
  readonly #onActiveRunChanged: RunsControllerOptions["onActiveRunChanged"];
  #summaries: readonly DesktopRunSummary[] = [];
  #selectedRunId: string | null = null;
  #taskId: string | null = null;
  #selectionGeneration = 0;
  #refreshing = false;

  constructor(options: RunsControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
    this.#onSummariesChanged = options.onSummariesChanged;
    this.#onActiveRunChanged = options.onActiveRunChanged;
  }

  mount(): void {
    requiredElement("#runs-refresh").addEventListener("click", () => { void this.refresh(); });
    requiredElement("#run-cancel").addEventListener("click", () => { void this.#cancelRun(); });
    requiredElement("#runs-list").addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-run-id]") : null;
      if (button?.dataset.runId !== undefined) this.#selectRun(button.dataset.runId);
    });
  }

  setTaskScope(taskId: string | null): void {
    if (this.#taskId === taskId) return;
    this.#taskId = taskId;
    const runs = this.#scopedRuns();
    this.#selectRun(runs.find((run) => ACTIVE_STATES.has(run.state))?.id ?? runs[0]?.id ?? null);
  }

  openRun(runId: string): void {
    if (!this.#scopedRuns().some((run) => run.id === runId)) this.#taskId = null;
    this.#selectRun(runId);
  }

  #scopedRuns(): readonly DesktopRunSummary[] {
    return runsInTaskScope(this.#summaries, this.#taskId);
  }

  async refresh(summaries?: readonly DesktopRunSummary[]): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      this.#summaries = summaries ?? await this.#api.getRuns(100);
      this.#onSummariesChanged?.(this.#summaries);
      const activeRuns = this.#summaries.filter((run) => ACTIVE_STATES.has(run.state));
      const scoped = this.#scopedRuns();
      if (!scoped.some((run) => run.id === this.#selectedRunId)) {
        this.#selectedRunId = scoped.find((run) => ACTIVE_STATES.has(run.state))?.id ?? scoped[0]?.id ?? null;
        this.#selectionGeneration += 1;
        this.#renderDetail(null);
      }
      this.#renderList();
      const generation = this.#selectionGeneration;
      const selected = this.#selectedRunId;
      const active = activeRuns[0]?.id ?? null;
      const records = new Map<string, DesktopRunRecord>();
      await Promise.all([...new Set([selected, active].filter((id): id is string => id !== null))].map(async (id) => {
        try { records.set(id, await this.#api.getRun(id)); }
        catch (error) { this.#notify(error instanceof Error ? error.message : "Could not read run details.", true); }
      }));
      if (generation === this.#selectionGeneration) {
        this.#renderDetail(selected === null ? null : records.get(selected) ?? null);
      }
      this.#onActiveRunChanged?.(active === null ? null : records.get(active) ?? null, activeRuns.length);
      requiredElement("#runs-refreshed").textContent =
        localText("Updated ", "更新于 ") + formatTimestamp(new Date().toISOString());
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not refresh background runs.", true);
    } finally {
      this.#refreshing = false;
    }
  }

  #selectRun(runId: string | null): void {
    this.#selectedRunId = runId;
    const generation = ++this.#selectionGeneration;
    this.#renderList();
    this.#renderDetail(null);
    if (runId === null) return;
    void this.#api.getRun(runId).then((run) => {
      if (generation === this.#selectionGeneration && this.#selectedRunId === run.id) this.#renderDetail(run);
    }).catch((error: unknown) => {
      if (generation !== this.#selectionGeneration) return;
      this.#notify(error instanceof Error ? error.message : "Could not read run details.", true);
    });
  }

  async #cancelRun(): Promise<void> {
    const runId = this.#selectedRunId;
    if (runId === null) return;
    requiredElement<HTMLButtonElement>("#run-cancel").disabled = true;
    try {
      const run = await this.#api.cancelRun(runId);
      if (run.id === this.#selectedRunId) this.#renderDetail(run);
      this.#notify(run.cancelRequested
        ? localText("Run cancellation requested.", "已请求取消运行。")
        : localText("Run is already complete.", "运行已经结束。"));
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not cancel the run.", true);
      await this.refresh();
    }
  }

  #renderList(): void {
    const runs = this.#scopedRuns();
    const container = requiredElement("#runs-list");
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>("[data-run-id]")?.dataset.runId : undefined;
    requiredElement("#runs-workbench-root").dataset.runScope = this.#taskId === null ? "all" : "task";
    requiredElement("#runs-scope-label").textContent = this.#taskId === null
      ? localText("All runs", "全部运行") : localText("Associated runs", "关联运行");
    requiredElement("#runs-count").textContent = localText(`${runs.length} runs`, `${runs.length} 次运行`);
    requiredElement("#run-scope-all").hidden = this.#taskId === null;
    requiredElement("#run-back-conversation").hidden = this.#taskId === null;
    requiredElement("#runs-empty-state").hidden = runs.length > 0;
    requiredElement("#runs-workbench").hidden = runs.length === 0;
    requiredElement("#runs-empty-title").textContent = this.#taskId === null
      ? localText("No run history yet", "暂无运行历史") : localText("No associated runs yet", "暂无关联运行");
    requiredElement("#runs-empty-description").textContent = this.#taskId === null
      ? localText("Managed processes, validation, Python and workflow runs appear here.", "托管进程、验证、Python 与工作流运行将显示在这里。")
      : localText("View all runs to inspect other execution records.", "可在全部运行中查看其他执行记录。");
    container.replaceChildren();
    const ordered = [...runs.filter((run) => ACTIVE_STATES.has(run.state)), ...runs.filter((run) => !ACTIVE_STATES.has(run.state))];
    for (const run of ordered) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.runId = run.id;
      button.className = "v2-run-row";
      button.classList.toggle("is-selected", run.id === this.#selectedRunId);
      button.setAttribute("aria-pressed", String(run.id === this.#selectedRunId));
      const identity = document.createElement("div");
      identity.className = "v2-run-row-identity";
      const label = document.createElement("strong");
      label.dataset.noI18n = "";
      label.textContent = run.label;
      const detail = document.createElement("span");
      detail.dataset.noI18n = "";
      const taskId = runTaskId(run);
      detail.textContent = `${run.kind} · ${run.id.slice(0, 8)} · ${taskId === null
        ? localText("No associated task", "未关联任务")
        : localText("Task ", "任务 ") + taskId} · ${formatTimestamp(run.createdAt)}`;
      identity.append(label, detail);
      const status = document.createElement("span");
      status.className = `run-state run-state-${run.state}`;
      status.textContent = stateLabel(run.state, run.cancelRequested);
      button.append(identity, status);
      container.append(button);
      if (focused === run.id) button.focus({ preventScroll: true });
    }
  }

  #renderDetail(record: DesktopRunRecord | null): void {
    const run = record !== null && (this.#taskId === null || runTaskId(record) === this.#taskId) ? record : null;
    const title = requiredElement("#run-detail-title");
    const values = requiredElement("#run-detail-meta").querySelectorAll<HTMLElement>("dd");
    const cancel = requiredElement<HTMLButtonElement>("#run-cancel");
    const association = requiredElement("#run-detail-association");
    const identity = requiredElement("#run-detail-identity");
    const stdout = requiredElement("#run-stdout");
    const stderr = requiredElement("#run-stderr");
    requiredElement("#run-output-truncated").hidden = run?.outputTruncated !== true;
    if (run === null) {
      title.removeAttribute("data-no-i18n");
      title.textContent = localText("No run selected", "未选择运行");
      identity.textContent = "";
      association.textContent = "";
      for (const value of values) value.textContent = "—";
      cancel.disabled = true;
      cancel.textContent = localText("Cancel run", "取消运行");
      renderOutputText(stdout, "", "Select a run to inspect output.");
      renderOutputText(stderr, "", "Select a run to inspect output.");
      requiredElement("#run-stdout-size").textContent = "0 B";
      requiredElement("#run-stderr-size").textContent = "0 B";
      return;
    }
    title.dataset.noI18n = "";
    title.textContent = run.label;
    identity.textContent = `${run.kind} · ${run.id} · ${run.workspaceId}`;
    const taskId = runTaskId(run);
    association.dataset.noI18n = "";
    association.textContent = taskId === null ? localText("No associated task", "未关联任务")
      : localText("Task ", "任务 ") + taskId;
    const detailValues = [
      stateLabel(run.state, run.cancelRequested), formatTimestamp(run.startedAt),
      formatDuration(effectiveDuration(run)), run.exitCode === null ? run.signal ?? "—" : String(run.exitCode),
    ];
    values.forEach((value, index) => { value.textContent = detailValues[index] ?? "—"; });
    cancel.disabled = !ACTIVE_STATES.has(run.state) || run.cancelRequested;
    cancel.textContent = run.cancelRequested && ACTIVE_STATES.has(run.state)
      ? localText("Cancelling…", "正在取消…") : localText("Cancel run", "取消运行");
    renderOutputText(stdout, run.stdout, "No stdout captured.");
    renderOutputText(stderr, run.stderr, "No stderr captured.");
    requiredElement("#run-stdout-size").textContent = formatBytes(outputBytes(run.stdout));
    requiredElement("#run-stderr-size").textContent = formatBytes(outputBytes(run.stderr));
  }
}
