import type {
  DesktopPythonCapabilities,
  DesktopRunRecord,
  DesktopRunState,
  DesktopRunSummary,
  SovereignDesktopApi,
} from "../shared.js";
import type { WorkbenchCodeEditor } from "./code-editor.js";

interface PythonControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "invokeTool" | "getRun" | "cancelRun">;
  readonly notify: (message: string, isError?: boolean) => void;
  readonly onRunStarted?: (run: DesktopRunRecord) => void;
}

const ACTIVE_RUN_STATES = new Set<DesktopRunState>(["queued", "running"]);

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Python UI element is missing: ${selector}`);
  }
  return element;
}

function parseArtifactPaths(value: string): readonly string[] {
  return [...new Set(value.split(",").map((path) => path.trim()).filter((path) => path.length > 0))];
}

function normalizeArtifactPath(value: string): string | null {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > 4096 ||
    candidate.includes(",") ||
    candidate.includes(":") ||
    candidate.startsWith("/") ||
    candidate.startsWith("\\") ||
    candidate.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    return null;
  }
  return candidate;
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "in progress";
  }
  if (value < 1_000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1_000).toFixed(1)} s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

const DEFAULT_PYTHON_SOURCE = `from pathlib import Path

print("workspace:", Path.cwd())
print("Sovereign Python is ready")
`;

export class PythonController {
  readonly #api: PythonControllerOptions["api"];
  readonly #notify: PythonControllerOptions["notify"];
  readonly #onRunStarted: PythonControllerOptions["onRunStarted"];
  #capabilities: DesktopPythonCapabilities | null = null;
  #refreshing = false;
  #editor: WorkbenchCodeEditor | null = null;
  #editorPromise: Promise<WorkbenchCodeEditor> | null = null;
  #liveRunId: string | null = null;
  #livePollTimer: number | null = null;

  constructor(options: PythonControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
    this.#onRunStarted = options.onRunStarted;
  }

  mount(): void {
    requiredElement<HTMLButtonElement>("#python-start-secondary").addEventListener("click", () => {
      void this.start();
    });
    requiredElement<HTMLButtonElement>("#python-refresh").addEventListener("click", () => {
      void this.refresh();
    });
    const artifactEntry = requiredElement<HTMLInputElement>("#python-artifact-entry");
    artifactEntry.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.#addArtifactPath(artifactEntry.value);
      } else if (event.key === "Backspace" && artifactEntry.value.length === 0) {
        const paths = [...parseArtifactPaths(requiredElement<HTMLInputElement>("#python-artifacts").value)];
        paths.pop();
        this.#setArtifactPaths(paths);
      }
    });
    requiredElement<HTMLDivElement>("#python-artifact-chips").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-artifact-remove]")
        : null;
      const path = button?.dataset.artifactRemove;
      if (path !== undefined) {
        this.#setArtifactPaths(parseArtifactPaths(requiredElement<HTMLInputElement>("#python-artifacts").value).filter((candidate) => candidate !== path));
      }
    });
    this.#renderArtifactPaths();
    requiredElement<HTMLButtonElement>("#python-live-cancel").addEventListener("click", () => {
      void this.#cancelLiveRun();
    });
  }

  async activate(): Promise<void> {
    try {
      const editor = await this.#ensureEditor();
      editor.requestMeasure();
      if (this.#liveRunId !== null) {
        await this.#refreshLiveRun();
      }
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not load the Python editor.", true);
    }
  }

  syncRuns(runs: readonly DesktopRunSummary[]): void {
    const candidate = runs.find(
      (run) => run.kind === "python" && ACTIVE_RUN_STATES.has(run.state),
    ) ?? runs.find((run) => run.kind === "python");
    if (candidate === undefined || candidate.id === this.#liveRunId) {
      return;
    }
    this.#liveRunId = candidate.id;
    void this.#refreshLiveRun();
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      return;
    }
    this.#refreshing = true;
    try {
      this.#capabilities = await this.#api.invokeTool<DesktopPythonCapabilities>(
        "python.capabilities",
        {},
      );
      this.#render();
      this.#editor?.requestMeasure();
      if (this.#liveRunId !== null) {
        await this.#refreshLiveRun();
      }
    } catch (error) {
      this.#capabilities = null;
      this.#render();
      this.#notify(error instanceof Error ? error.message : "Could not inspect Python.", true);
    } finally {
      this.#refreshing = false;
    }
  }

  async start(): Promise<void> {
    let editor: WorkbenchCodeEditor;
    try {
      editor = await this.#ensureEditor();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not load the Python editor.", true);
      return;
    }
    const code = editor.getValue();
    const cwd = requiredElement<HTMLInputElement>("#python-cwd").value.trim();
    const timeoutSeconds = Number.parseInt(
      requiredElement<HTMLInputElement>("#python-timeout").value,
      10,
    );
    const timeoutMs = timeoutSeconds * 1_000;
    const artifactEntry = requiredElement<HTMLInputElement>("#python-artifact-entry");
    const pendingArtifact = artifactEntry.value.trim();
    if (pendingArtifact.length > 0) {
      const normalized = normalizeArtifactPath(pendingArtifact);
      if (normalized === null) {
        this.#notify("Artifact paths must stay workspace-relative and may not contain drive prefixes, parent traversal or commas.", true);
        return;
      }
      this.#setArtifactPaths([
        ...parseArtifactPaths(requiredElement<HTMLInputElement>("#python-artifacts").value),
        normalized,
      ]);
      artifactEntry.value = "";
    }
    const artifactPaths = parseArtifactPaths(
      requiredElement<HTMLInputElement>("#python-artifacts").value,
    );
    if (code.trim().length === 0) {
      this.#notify("Python source is empty.", true);
      return;
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
      this.#notify("Python timeout must be from 1 through 900 seconds.", true);
      return;
    }

    this.#setRunButtonsDisabled(true);
    try {
      const run = await this.#api.invokeTool<DesktopRunRecord>("python.start", {
        mode: "code",
        code,
        cwd,
        artifactPaths,
        timeoutMs,
      });
      this.#liveRunId = run.id;
      this.#renderLiveRun(run, true);
      this.#scheduleLiveRefresh(run);
      this.#onRunStarted?.(run);
      this.#notify(`Python run started: ${run.id.slice(0, 8)}. Live Console is open.`);
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not start Python.", true);
    } finally {
      this.#setRunButtonsDisabled(this.#capabilities?.available !== true);
    }
  }

  async #ensureEditor(): Promise<WorkbenchCodeEditor> {
    if (this.#editor !== null) {
      return this.#editor;
    }
    if (this.#editorPromise === null) {
      this.#editorPromise = import("./code-editor.js").then(({ WorkbenchCodeEditor }) => {
        const editor = new WorkbenchCodeEditor({
          parent: requiredElement<HTMLElement>("#python-code-editor"),
          value: DEFAULT_PYTHON_SOURCE,
          language: "python",
          ariaLabel: "Python task editor",
        });
        this.#editor = editor;
        return editor;
      }).catch((error: unknown) => {
        this.#editorPromise = null;
        throw error;
      });
    }
    return this.#editorPromise;
  }

  async #refreshLiveRun(): Promise<void> {
    const runId = this.#liveRunId;
    if (runId === null) {
      return;
    }
    try {
      const run = await this.#api.getRun(runId);
      this.#renderLiveRun(run, false);
      this.#scheduleLiveRefresh(run);
    } catch (error) {
      this.#clearLivePoll();
      const state = requiredElement<HTMLElement>("#python-live-state");
      state.textContent = "Live run unavailable";
      state.className = "state-text is-error";
      this.#notify(error instanceof Error ? error.message : "Could not refresh the Python run.", true);
    }
  }

  async #cancelLiveRun(): Promise<void> {
    const runId = this.#liveRunId;
    if (runId === null) {
      return;
    }
    const cancel = requiredElement<HTMLButtonElement>("#python-live-cancel");
    cancel.disabled = true;
    try {
      const run = await this.#api.cancelRun(runId);
      this.#renderLiveRun(run, false);
      this.#scheduleLiveRefresh(run);
      this.#notify(run.cancelRequested ? "Python run cancellation requested." : "Python run is already complete.");
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not cancel the Python run.", true);
    }
  }

  #scheduleLiveRefresh(run: DesktopRunRecord): void {
    this.#clearLivePoll();
    if (!ACTIVE_RUN_STATES.has(run.state)) {
      return;
    }
    this.#livePollTimer = window.setTimeout(() => {
      this.#livePollTimer = null;
      void this.#refreshLiveRun();
    }, 800);
  }

  #clearLivePoll(): void {
    if (this.#livePollTimer !== null) {
      window.clearTimeout(this.#livePollTimer);
      this.#livePollTimer = null;
    }
  }

  #renderLiveRun(run: DesktopRunRecord, reveal: boolean): void {
    const consolePanel = requiredElement<HTMLDetailsElement>("#python-live-console");
    consolePanel.hidden = false;
    if (reveal) {
      consolePanel.open = true;
    }
    const active = ACTIVE_RUN_STATES.has(run.state);
    const displayState = run.cancelRequested && active ? "cancelling" : run.state;
    const state = requiredElement<HTMLElement>("#python-live-state");
    state.textContent = `Python run ${displayState}`;
    state.className = `state-text${run.state === "succeeded" ? " is-healthy" : ["failed", "timed-out", "interrupted"].includes(run.state) ? " is-error" : ""}`;
    requiredElement<HTMLElement>("#python-live-run-id").textContent = run.id;
    requiredElement<HTMLElement>("#python-live-meta").textContent =
      `${run.kind} · ${formatDuration(run.durationMs)}${run.exitCode === null ? "" : ` · exit ${run.exitCode}`}`;
    requiredElement<HTMLElement>("#python-live-stdout").textContent = run.stdout.length === 0
      ? active ? "Waiting for stdout…" : "No stdout captured."
      : run.stdout;
    requiredElement<HTMLElement>("#python-live-stderr").textContent = run.stderr.length === 0
      ? active ? "No stderr yet." : "No stderr captured."
      : run.stderr;
    const cancel = requiredElement<HTMLButtonElement>("#python-live-cancel");
    cancel.disabled = !active || run.cancelRequested;
    cancel.textContent = run.cancelRequested && active ? "Cancelling…" : "Cancel run";
  }

  #addArtifactPath(value: string): void {
    const path = normalizeArtifactPath(value);
    if (path === null) {
      this.#notify("Artifact paths must stay workspace-relative and may not contain drive prefixes, parent traversal or commas.", true);
      return;
    }
    const paths = [...parseArtifactPaths(requiredElement<HTMLInputElement>("#python-artifacts").value)];
    if (!paths.includes(path)) {
      paths.push(path);
    }
    this.#setArtifactPaths(paths);
    requiredElement<HTMLInputElement>("#python-artifact-entry").value = "";
  }

  #setArtifactPaths(paths: readonly string[]): void {
    requiredElement<HTMLInputElement>("#python-artifacts").value = [...new Set(paths)].join(",");
    this.#renderArtifactPaths();
  }

  #renderArtifactPaths(): void {
    const paths = parseArtifactPaths(requiredElement<HTMLInputElement>("#python-artifacts").value);
    const container = requiredElement<HTMLDivElement>("#python-artifact-chips");
    container.replaceChildren();
    for (const path of paths) {
      const chip = document.createElement("span");
      chip.className = "token-chip";
      const text = document.createElement("span");
      text.textContent = path;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.artifactRemove = path;
      remove.setAttribute("aria-label", `Remove artifact ${path}`);
      remove.textContent = "×";
      chip.append(text, remove);
      container.append(chip);
    }
    requiredElement<HTMLElement>("#python-contract-result").textContent = paths.length === 0
      ? "Background run with stdout, stderr, cancellation and no declared artifacts"
      : `Background run with stdout, stderr, cancellation and ${paths.length} declared artifact${paths.length === 1 ? "" : "s"}`;
  }

  #setRunButtonsDisabled(disabled: boolean): void {
    requiredElement<HTMLButtonElement>("#python-start-secondary").disabled = disabled;
  }

  #render(): void {
    const capability = requiredElement<HTMLElement>("#python-capability");
    const title = requiredElement<HTMLElement>("#python-runtime-title");
    const launcher = requiredElement<HTMLElement>("#python-launcher");
    const version = requiredElement<HTMLElement>("#python-version");
    if (this.#capabilities === null) {
      capability.textContent = "Python unavailable";
      capability.className = "state-text is-error";
      title.textContent = "Python runtime unavailable";
      launcher.textContent = "—";
      version.textContent = "—";
      this.#setRunButtonsDisabled(true);
      return;
    }

    capability.textContent = this.#capabilities.available
      ? `${this.#capabilities.implementation ?? "Python"} ${this.#capabilities.version ?? ""} available`.trim()
      : "Python runtime not found";
    capability.className = `state-text${this.#capabilities.available ? " is-healthy" : " is-error"}`;
    title.textContent = this.#capabilities.available
      ? this.#capabilities.implementation ?? "Python"
      : "No supported Python 3 runtime";
    launcher.textContent = this.#capabilities.launcher ?? "—";
    version.textContent = this.#capabilities.version ?? "—";
    this.#setRunButtonsDisabled(!this.#capabilities.available);
  }
}
