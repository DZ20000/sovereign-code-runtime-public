import type {
  DesktopRunRecord,
  DesktopRunState,
  DesktopRunSummary,
  SovereignDesktopApi,
} from "../shared.js";

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
const ACTIVE_OUTPUT_LIMIT = 3_000;

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

function recentOutput(value: string): string {
  if (value.length <= ACTIVE_OUTPUT_LIMIT) {
    return value;
  }
  return `…${value.slice(-ACTIVE_OUTPUT_LIMIT)}`;
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

export class RunsController {
  readonly #api: RunsControllerOptions["api"];
  readonly #notify: RunsControllerOptions["notify"];
  readonly #onSummariesChanged: RunsControllerOptions["onSummariesChanged"];
  readonly #onActiveRunChanged: RunsControllerOptions["onActiveRunChanged"];
  #summaries: readonly DesktopRunSummary[] = [];
  #selectedRunId: string | null = null;
  #activeRunId: string | null = null;
  #refreshing = false;

  constructor(options: RunsControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
    this.#onSummariesChanged = options.onSummariesChanged;
    this.#onActiveRunChanged = options.onActiveRunChanged;
  }

  mount(): void {
    requiredElement<HTMLButtonElement>("#runs-refresh").addEventListener("click", () => {
      void this.refresh();
    });
    requiredElement<HTMLButtonElement>("#run-cancel").addEventListener("click", () => {
      void this.#cancelRun(this.#selectedRunId);
    });
    requiredElement<HTMLButtonElement>("#active-run-cancel").addEventListener("click", () => {
      void this.#cancelRun(this.#activeRunId);
    });
    requiredElement<HTMLButtonElement>("#active-run-view").addEventListener("click", () => {
      if (this.#activeRunId === null) {
        return;
      }
      document.querySelector<HTMLButtonElement>("#runs-tab-runs")?.click();
      this.#selectRun(this.#activeRunId);
    });
    requiredElement<HTMLDivElement>("#runs-list").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-run-id]")
        : null;
      const runId = button?.dataset.runId;
      if (runId !== undefined) {
        this.#selectRun(runId);
      }
    });
  }

  openRun(runId: string): void {
    this.#selectRun(runId);
  }

  async refresh(summaries?: readonly DesktopRunSummary[]): Promise<void> {
    if (this.#refreshing) {
      return;
    }
    this.#refreshing = true;
    try {
      this.#summaries = summaries ?? await this.#api.getRuns(100);
      this.#onSummariesChanged?.(this.#summaries);

      const activeRuns = this.#summaries.filter((run) => ACTIVE_STATES.has(run.state));
      this.#activeRunId = activeRuns[0]?.id ?? null;
      if (
        this.#selectedRunId === null ||
        !this.#summaries.some((run) => run.id === this.#selectedRunId)
      ) {
        this.#selectedRunId = this.#activeRunId ?? this.#summaries[0]?.id ?? null;
      }

      this.#renderList();
      this.#renderActiveSummary(activeRuns[0] ?? null, activeRuns.length);

      const requestedIds = [...new Set(
        [this.#selectedRunId, this.#activeRunId].filter((runId): runId is string => runId !== null),
      )];
      const records = new Map<string, DesktopRunRecord>();
      await Promise.all(requestedIds.map(async (runId) => {
        try {
          records.set(runId, await this.#api.getRun(runId));
        } catch (error) {
          this.#notify(error instanceof Error ? error.message : "Could not read run details.", true);
        }
      }));

      this.#renderDetail(this.#selectedRunId === null ? null : records.get(this.#selectedRunId) ?? null);
      const activeRecord = this.#activeRunId === null
        ? null
        : records.get(this.#activeRunId) ?? null;
      this.#renderActiveRun(activeRecord, activeRuns.length);
      this.#onActiveRunChanged?.(activeRecord, activeRuns.length);
      requiredElement<HTMLElement>("#runs-refreshed").textContent =
        `Updated ${formatTimestamp(new Date().toISOString())}`;
    } catch (error) {
      this.#notify(
        error instanceof Error ? error.message : "Could not refresh background runs.",
        true,
      );
    } finally {
      this.#refreshing = false;
    }
  }

  #selectRun(runId: string): void {
    this.#selectedRunId = runId;
    this.#renderList();
    void this.#api.getRun(runId).then((run) => {
      if (this.#selectedRunId === runId) {
        this.#renderDetail(run);
      }
    }).catch((error: unknown) => {
      if (this.#selectedRunId === runId) {
        this.#renderDetail(null);
        this.#notify(error instanceof Error ? error.message : "Could not read run details.", true);
      }
    });
  }

  async #cancelRun(runId: string | null): Promise<void> {
    if (runId === null) {
      return;
    }
    const detailButton = requiredElement<HTMLButtonElement>("#run-cancel");
    const activeButton = requiredElement<HTMLButtonElement>("#active-run-cancel");
    detailButton.disabled = true;
    activeButton.disabled = true;
    try {
      const run = await this.#api.cancelRun(runId);
      if (run.id === this.#selectedRunId) {
        this.#renderDetail(run);
      }
      if (run.id === this.#activeRunId) {
        this.#renderActiveRun(run, this.#summaries.filter((item) => ACTIVE_STATES.has(item.state)).length);
      }
      this.#notify(run.cancelRequested ? "Task cancellation requested." : "Task is already complete.");
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not cancel the task.", true);
      await this.refresh();
    }
  }

  #renderList(): void {
    const container = requiredElement<HTMLDivElement>("#runs-list");
    const activeCount = this.#summaries.filter((run) => ACTIVE_STATES.has(run.state)).length;
    requiredElement<HTMLElement>("#runs-count").textContent =
      activeCount > 0
        ? `${activeCount} active · ${this.#summaries.length} total`
        : `${this.#summaries.length} run${this.#summaries.length === 1 ? "" : "s"}`;
    const hasRuns = this.#summaries.length > 0;
    requiredElement<HTMLElement>("#runs-empty-state").hidden = hasRuns;
    requiredElement<HTMLElement>("#runs-workbench").hidden = !hasRuns;
    container.replaceChildren();

    if (!hasRuns) {
      return;
    }

    const orderedRuns = [
      ...this.#summaries.filter((run) => ACTIVE_STATES.has(run.state)),
      ...this.#summaries.filter((run) => !ACTIVE_STATES.has(run.state)),
    ];
    for (const run of orderedRuns) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.runId = run.id;
      button.className = "run-row";
      button.classList.toggle("is-selected", run.id === this.#selectedRunId);
      button.setAttribute("aria-pressed", run.id === this.#selectedRunId ? "true" : "false");

      const identity = document.createElement("div");
      identity.className = "run-row-identity";
      const label = document.createElement("strong");
      label.setAttribute("data-no-i18n", "");
      label.textContent = run.label;
      const detail = document.createElement("span");
      detail.textContent = `${run.kind} · ${run.id.slice(0, 8)} · `;
      // Its own element so a narrow row breaks before the timestamp rather
      // than inside it, which would read as two separate values.
      const created = document.createElement("time");
      created.dateTime = run.createdAt;
      created.textContent = formatTimestamp(run.createdAt);
      detail.append(created);
      identity.append(label, detail);

      const status = document.createElement("span");
      status.className = `run-state run-state-${run.state}`;
      status.textContent = stateLabel(run.state, run.cancelRequested);

      button.append(identity, status);
      container.append(button);
    }
  }

  #renderActiveSummary(run: DesktopRunSummary | null, activeCount: number): void {
    const section = requiredElement<HTMLElement>("#active-run-section");
    const empty = requiredElement<HTMLElement>("#active-run-empty");
    section.hidden = run === null;
    empty.hidden = run !== null;
    if (run === null) {
      return;
    }

    requiredElement<HTMLElement>("#active-run-title").setAttribute("data-no-i18n", "");
    requiredElement<HTMLElement>("#active-run-title").textContent = run.label;
    requiredElement<HTMLElement>("#active-run-kind").textContent = `${run.kind} · ${run.id.slice(0, 8)}`;
    const state = requiredElement<HTMLElement>("#active-run-state");
    state.className = `run-state run-state-${run.state}`;
    state.textContent = stateLabel(run.state, run.cancelRequested);
    requiredElement<HTMLElement>("#active-run-count").textContent =
      `${activeCount} active task${activeCount === 1 ? "" : "s"}`;
    requiredElement<HTMLElement>("#active-run-started").textContent = formatTimestamp(run.startedAt);
    requiredElement<HTMLElement>("#active-run-duration").textContent = formatDuration(effectiveDuration(run));
    renderOutputText(requiredElement<HTMLElement>("#active-run-output"), "", "Loading recent output…");
    requiredElement<HTMLElement>("#active-run-output-size").textContent =
      formatBytes(run.stdoutBytes + run.stderrBytes);
    requiredElement<HTMLButtonElement>("#active-run-cancel").disabled = run.cancelRequested;
  }

  #renderActiveRun(run: DesktopRunRecord | null, activeCount: number): void {
    if (run === null) {
      if (this.#activeRunId === null) {
        requiredElement<HTMLElement>("#active-run-section").hidden = true;
        requiredElement<HTMLElement>("#active-run-empty").hidden = false;
      }
      return;
    }

    requiredElement<HTMLElement>("#active-run-title").setAttribute("data-no-i18n", "");
    requiredElement<HTMLElement>("#active-run-title").textContent = run.label;
    requiredElement<HTMLElement>("#active-run-kind").textContent = `${run.kind} · ${run.id.slice(0, 8)}`;
    const state = requiredElement<HTMLElement>("#active-run-state");
    state.className = `run-state run-state-${run.state}`;
    state.textContent = stateLabel(run.state, run.cancelRequested);
    requiredElement<HTMLElement>("#active-run-count").textContent =
      `${activeCount} active task${activeCount === 1 ? "" : "s"}`;
    requiredElement<HTMLElement>("#active-run-started").textContent = formatTimestamp(run.startedAt);
    requiredElement<HTMLElement>("#active-run-duration").textContent = formatDuration(effectiveDuration(run));

    const output = run.stdout.length > 0 ? run.stdout : run.stderr;
    requiredElement<HTMLElement>("#active-run-output-label").textContent =
      run.stdout.length > 0 ? "Recent output" : run.stderr.length > 0 ? "Recent errors" : "Recent output";
    renderOutputText(requiredElement<HTMLElement>("#active-run-output"), recentOutput(output), "No output yet.");
    requiredElement<HTMLElement>("#active-run-output-size").textContent = formatBytes(outputBytes(output));
    requiredElement<HTMLButtonElement>("#active-run-cancel").disabled =
      !ACTIVE_STATES.has(run.state) || run.cancelRequested;
  }

  #renderDetail(run: DesktopRunRecord | null): void {
    const title = requiredElement<HTMLElement>("#run-detail-title");
    const meta = requiredElement<HTMLElement>("#run-detail-meta");
    const values = meta.querySelectorAll<HTMLElement>("dd");
    const cancel = requiredElement<HTMLButtonElement>("#run-cancel");
    const stdout = requiredElement<HTMLElement>("#run-stdout");
    const stderr = requiredElement<HTMLElement>("#run-stderr");

    if (run === null) {
      title.removeAttribute("data-no-i18n");
      title.textContent = "No run selected";
      for (const value of values) {
        value.textContent = "—";
      }
      cancel.disabled = true;
      cancel.textContent = "Cancel task";
      renderOutputText(stdout, "", "Select a run to inspect output.");
      renderOutputText(stderr, "", "Select a run to inspect output.");
      requiredElement<HTMLElement>("#run-stdout-size").textContent = "0 B";
      requiredElement<HTMLElement>("#run-stderr-size").textContent = "0 B";
      return;
    }

    title.setAttribute("data-no-i18n", "");
    title.textContent = run.label;
    const detailValues = [
      stateLabel(run.state, run.cancelRequested),
      formatTimestamp(run.startedAt),
      formatDuration(effectiveDuration(run)),
      run.exitCode === null ? run.signal ?? "—" : String(run.exitCode),
    ];
    values.forEach((value, index) => {
      value.textContent = detailValues[index] ?? "—";
    });

    cancel.disabled = !ACTIVE_STATES.has(run.state) || run.cancelRequested;
    cancel.textContent = run.cancelRequested && ACTIVE_STATES.has(run.state)
      ? "Cancelling…"
      : "Cancel task";
    renderOutputText(stdout, run.stdout, "No stdout captured.");
    renderOutputText(stderr, run.stderr, "No stderr captured.");
    requiredElement<HTMLElement>("#run-stdout-size").textContent = formatBytes(outputBytes(run.stdout));
    requiredElement<HTMLElement>("#run-stderr-size").textContent = formatBytes(outputBytes(run.stderr));
  }
}
