import type {
  DesktopRunRecord,
  DesktopWorkflowStep,
  SovereignDesktopApi,
} from "../shared.js";
import type { WorkbenchCodeEditor } from "./code-editor.js";

interface WorkflowControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "invokeTool">;
  readonly notify: (message: string, isError?: boolean) => void;
  readonly onRunStarted?: (run: DesktopRunRecord) => void;
}

interface WorkflowTemplate {
  readonly id: string;
  readonly label: string;
  readonly steps: readonly DesktopWorkflowStep[];
}

interface BuilderFocus {
  readonly index: number;
  readonly field?: string | undefined;
  readonly action?: string | undefined;
}

interface WorkflowUndo {
  readonly label: string;
  readonly steps: DesktopWorkflowStep[];
  readonly json: string | null;
  readonly error: string | null;
  readonly focus: BuilderFocus | null;
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Workflow UI element is missing: ${selector}`);
  }
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSteps(source: string): DesktopWorkflowStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Steps JSON is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) {
    throw new Error("A workflow requires 1 through 20 steps.");
  }
  return parsed.map((candidate, index): DesktopWorkflowStep => {
    if (!isRecord(candidate) || typeof candidate.kind !== "string") {
      throw new Error(`Step ${index + 1} must define a kind.`);
    }
    if (candidate.kind === "validation") {
      if (!["typecheck", "test", "build"].includes(String(candidate.task))) {
        throw new Error(`Validation step ${index + 1} has an invalid task.`);
      }
      return {
        kind: "validation",
        task: candidate.task as "typecheck" | "test" | "build",
      };
    }
    if (candidate.kind === "terminal") {
      if (typeof candidate.command !== "string" || candidate.command.trim().length === 0) {
        throw new Error(`Terminal step ${index + 1} requires a command.`);
      }
      return { kind: "terminal", command: candidate.command };
    }
    if (candidate.kind === "python") {
      if (typeof candidate.code !== "string" || candidate.code.trim().length === 0) {
        throw new Error(`Python step ${index + 1} requires code.`);
      }
      return { kind: "python", code: candidate.code };
    }
    throw new Error(`Step ${index + 1} uses an unsupported kind.`);
  });
}

function parseTemplate(value: unknown): WorkflowTemplate | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") {
    return null;
  }
  try {
    return {
      id: value.id,
      label: value.label,
      steps: parseSteps(JSON.stringify(value.steps)),
    };
  } catch {
    return null;
  }
}

function defaultStep(kind: DesktopWorkflowStep["kind"]): DesktopWorkflowStep {
  if (kind === "validation") {
    return { kind: "validation", task: "typecheck" };
  }
  if (kind === "terminal") {
    return { kind: "terminal", command: "pnpm test" };
  }
  return { kind: "python", code: "print(\"workflow step\")" };
}

function stepAuthority(step: DesktopWorkflowStep): "L2" | "L3" {
  return step.kind === "validation" ? "L2" : "L3";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const INITIAL_STEPS: DesktopWorkflowStep[] = [
  { kind: "validation", task: "typecheck" },
  { kind: "validation", task: "test" },
];

export class WorkflowController {
  readonly #api: WorkflowControllerOptions["api"];
  readonly #notify: WorkflowControllerOptions["notify"];
  readonly #onRunStarted: WorkflowControllerOptions["onRunStarted"];
  #templates: readonly WorkflowTemplate[] = [];
  #steps: DesktopWorkflowStep[] = [...INITIAL_STEPS];
  #refreshing = false;
  #editor: WorkbenchCodeEditor | null = null;
  #editorPromise: Promise<WorkbenchCodeEditor> | null = null;
  #syncingEditor = false;
  #validationError: string | null = null;
  #undo: WorkflowUndo | null = null;

  constructor(options: WorkflowControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
    this.#onRunStarted = options.onRunStarted;
  }

  mount(): void {
    requiredElement<HTMLButtonElement>("#workflow-undo").addEventListener("click", () => this.#undoChange());
    requiredElement<HTMLInputElement>("#workflow-label").addEventListener("input", () => this.#clearUndo());
    const addMenu = requiredElement<HTMLDetailsElement>(".workflow-add-menu");
    addMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && addMenu.open) {
        event.preventDefault();
        addMenu.open = false;
        addMenu.querySelector("summary")?.focus();
      }
    });
    requiredElement<HTMLButtonElement>("#workflow-refresh").addEventListener("click", () => {
      void this.refresh();
    });
    requiredElement<HTMLButtonElement>("#workflow-start-secondary").addEventListener("click", () => {
      void this.start();
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-workflow-add]")) {
      button.addEventListener("click", () => {
        const kind = button.dataset.workflowAdd;
        if (kind === "validation" || kind === "terminal" || kind === "python") {
          this.#rememberChange();
          this.#steps.push(defaultStep(kind));
          this.#syncFromBuilder(true, { index: this.#steps.length - 1, field: "kind" });
          button.closest<HTMLDetailsElement>("details")?.removeAttribute("open");
        }
      });
    }
    const jsonDetails = requiredElement<HTMLDetailsElement>("#workflow-json-advanced");
    jsonDetails.addEventListener("toggle", () => {
      if (jsonDetails.open) {
        void this.#activateJsonEditor();
      }
    });

    const builder = requiredElement<HTMLDivElement>("#workflow-step-builder");
    builder.addEventListener("click", (event) => this.#handleBuilderClick(event));
    builder.addEventListener("input", (event) => this.#handleBuilderField(event));
    builder.addEventListener("change", (event) => this.#handleBuilderField(event));

    requiredElement<HTMLDivElement>("#workflow-template-list").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-workflow-template-id]")
        : null;
      const templateId = button?.dataset.workflowTemplateId;
      const template = this.#templates.find((candidate) => candidate.id === templateId);
      if (template !== undefined) {
        this.#rememberChange();
        requiredElement<HTMLInputElement>("#workflow-label").value = template.label;
        this.#steps = template.steps.map((step) => ({ ...step }));
        this.#syncFromBuilder(true);
        this.#notify(`Loaded template: ${template.label}.`);
      }
    });

    this.#renderBuilder();
    this.#renderValidation();
  }

  async activate(): Promise<void> {
    const details = requiredElement<HTMLDetailsElement>("#workflow-json-advanced");
    if (details.open) {
      await this.#activateJsonEditor();
    }
  }

  async #activateJsonEditor(): Promise<void> {
    try {
      const editor = await this.#ensureEditor();
      editor.requestMeasure();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not load the workflow JSON editor.", true);
    }
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      return;
    }
    this.#refreshing = true;
    try {
      const values = await this.#api.invokeTool<readonly unknown[]>("workflow.templates", {});
      this.#templates = values.flatMap((value) => {
        const template = parseTemplate(value);
        return template === null ? [] : [template];
      });
      this.#renderTemplates();
      this.#editor?.requestMeasure();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not load workflows.", true);
    } finally {
      this.#refreshing = false;
    }
  }

  async start(): Promise<void> {
    if (this.#validationError !== null) {
      this.#notify(this.#validationError, true);
      return;
    }
    const label = requiredElement<HTMLInputElement>("#workflow-label").value.trim();
    const cwd = requiredElement<HTMLInputElement>("#workflow-cwd").value.trim();
    const timeoutSeconds = Number.parseInt(
      requiredElement<HTMLInputElement>("#workflow-timeout").value,
      10,
    );
    if (label.length === 0) {
      this.#notify("Workflow label is required.", true);
      return;
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600) {
      this.#notify("Workflow timeout must be from 1 through 3600 seconds.", true);
      return;
    }

    this.#setRunButtonsDisabled(true);
    try {
      const run = await this.#api.invokeTool<DesktopRunRecord>("workflow.start", {
        label,
        steps: this.#steps,
        cwd,
        timeoutMs: timeoutSeconds * 1_000,
      });
      this.#onRunStarted?.(run);
      this.#notify(`Workflow started: ${run.id.slice(0, 8)}. Open Runs for live output.`);
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not start workflow.", true);
    } finally {
      this.#setRunButtonsDisabled(this.#validationError !== null);
    }
  }

  async #ensureEditor(): Promise<WorkbenchCodeEditor> {
    if (this.#editor !== null) {
      return this.#editor;
    }
    if (this.#editorPromise === null) {
      this.#editorPromise = import("./code-editor.js").then(({ WorkbenchCodeEditor }) => {
        const editor = new WorkbenchCodeEditor({
          parent: requiredElement<HTMLElement>("#workflow-json-editor"),
          value: JSON.stringify(this.#steps, null, 2),
          language: "json",
          ariaLabel: "Workflow steps JSON editor",
          onChange: (value) => this.#handleJsonChange(value),
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

  #handleJsonChange(value: string): void {
    if (this.#syncingEditor) {
      return;
    }
    this.#clearUndo();
    try {
      this.#steps = parseSteps(value);
      this.#validationError = null;
      this.#renderBuilder();
    } catch (error) {
      this.#validationError = error instanceof Error ? error.message : "Workflow JSON is invalid.";
    }
    this.#renderValidation();
  }

  #handleBuilderClick(event: Event): void {
    const target = event.target;
    const button = target instanceof Element
      ? target.closest<HTMLButtonElement>("button[data-workflow-step-action]")
      : null;
    if (button === null) {
      return;
    }
    const index = Number.parseInt(button.dataset.workflowStepIndex ?? "", 10);
    const action = button.dataset.workflowStepAction;
    if (!Number.isInteger(index) || index < 0 || index >= this.#steps.length) {
      return;
    }
    if (action === "remove") {
      if (this.#steps.length === 1) {
        this.#notify("A workflow must contain at least one step.", true);
        return;
      }
      this.#rememberChange();
      this.#steps.splice(index, 1);
    } else if (action === "up" && index > 0) {
      this.#rememberChange();
      const [step] = this.#steps.splice(index, 1);
      if (step !== undefined) {
        this.#steps.splice(index - 1, 0, step);
      }
    } else if (action === "down" && index < this.#steps.length - 1) {
      this.#rememberChange();
      const [step] = this.#steps.splice(index, 1);
      if (step !== undefined) {
        this.#steps.splice(index + 1, 0, step);
      }
    } else {
      return;
    }
    const nextIndex = action === "up" ? index - 1 : action === "down" ? index + 1 : Math.min(index, this.#steps.length - 1);
    this.#syncFromBuilder(true, { index: nextIndex, action });
  }

  #handleBuilderField(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }
    const index = Number.parseInt(target.dataset.workflowStepIndex ?? "", 10);
    const field = target.dataset.workflowStepField;
    if (!Number.isInteger(index) || index < 0 || index >= this.#steps.length || field === undefined) {
      return;
    }
    const step = this.#steps[index];
    if (step === undefined) {
      return;
    }

    if (field === "kind") {
      const kind = target.value;
      if (kind !== step.kind && (kind === "validation" || kind === "terminal" || kind === "python")) {
        this.#rememberChange();
        this.#steps[index] = defaultStep(kind);
        this.#syncFromBuilder(true);
      }
      return;
    }
    this.#clearUndo();
    if (step.kind === "validation" && field === "task") {
      const task = target.value;
      if (task === "typecheck" || task === "test" || task === "build") {
        this.#steps[index] = { kind: "validation", task };
        this.#syncFromBuilder(false);
      }
      return;
    }
    if (step.kind === "terminal" && field === "command") {
      this.#steps[index] = { kind: "terminal", command: target.value };
      this.#syncFromBuilder(false);
      return;
    }
    if (step.kind === "python" && field === "code") {
      this.#steps[index] = { kind: "python", code: target.value };
      this.#syncFromBuilder(false);
    }
  }

  #syncFromBuilder(renderBuilder: boolean, focus?: BuilderFocus | null): void {
    try {
      parseSteps(JSON.stringify(this.#steps));
      this.#validationError = null;
    } catch (error) {
      this.#validationError = error instanceof Error ? error.message : "Workflow steps are invalid.";
    }
    this.#syncingEditor = true;
    try {
      this.#editor?.setValue(JSON.stringify(this.#steps, null, 2));
    } finally {
      this.#syncingEditor = false;
    }
    if (renderBuilder) {
      this.#renderBuilder(focus);
    }
    this.#renderValidation();
  }

  #currentBuilderFocus(): BuilderFocus | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest("#workflow-step-builder")) return null;
    const index = Number.parseInt(active.dataset.workflowStepIndex ?? "", 10);
    if (!Number.isInteger(index)) return null;
    return { index, field: active.dataset.workflowStepField, action: active.dataset.workflowStepAction };
  }

  #rememberChange(): void {
    this.#undo = {
      label: requiredElement<HTMLInputElement>("#workflow-label").value,
      steps: this.#steps.map((step) => ({ ...step })),
      json: this.#editor?.getValue() ?? null,
      error: this.#validationError,
      focus: this.#currentBuilderFocus(),
    };
  }

  #clearUndo(): void {
    this.#undo = null;
    requiredElement<HTMLButtonElement>("#workflow-undo").disabled = true;
  }

  #undoChange(): void {
    const previous = this.#undo;
    if (previous === null) return;
    this.#undo = null;
    this.#steps = previous.steps;
    requiredElement<HTMLInputElement>("#workflow-label").value = previous.label;
    this.#syncFromBuilder(true, previous.focus ?? { index: 0, field: "kind" });
    if (previous.json !== null && this.#editor !== null) {
      this.#syncingEditor = true;
      try {
        this.#editor.setValue(previous.json);
      } finally {
        this.#syncingEditor = false;
      }
      this.#validationError = previous.error;
      this.#renderValidation();
    }
    this.#notify("Workflow change undone.");
  }

  #renderBuilder(focus: BuilderFocus | null = this.#currentBuilderFocus()): void {
    const container = requiredElement<HTMLDivElement>("#workflow-step-builder");
    container.innerHTML = this.#steps.map((step, index) => {
      const controls = step.kind === "validation"
        ? `<label><span>Task</span><select class="settings-select" data-workflow-step-index="${index}" data-workflow-step-field="task">
            <option value="typecheck"${step.task === "typecheck" ? " selected" : ""}>Typecheck</option>
            <option value="test"${step.task === "test" ? " selected" : ""}>Tests</option>
            <option value="build"${step.task === "build" ? " selected" : ""}>Build</option>
          </select></label>`
        : step.kind === "terminal"
          ? `<label class="workflow-step-wide"><span>Command</span><input class="text-field" data-workflow-step-index="${index}" data-workflow-step-field="command" value="${escapeHtml(step.command)}" /></label>`
          : `<label class="workflow-step-wide"><span>Python code</span><textarea class="workflow-step-code" data-workflow-step-index="${index}" data-workflow-step-field="code">${escapeHtml(step.code)}</textarea></label>`;
      return `
        <article class="workflow-step-row">
          <div class="workflow-step-index">${index + 1}</div>
          <div class="workflow-step-body">
            <div class="workflow-step-topline">
              <select class="workflow-kind-select" data-workflow-step-index="${index}" data-workflow-step-field="kind" aria-label="Step ${index + 1} kind">
                <option value="validation"${step.kind === "validation" ? " selected" : ""}>Validation</option>
                <option value="terminal"${step.kind === "terminal" ? " selected" : ""}>Terminal</option>
                <option value="python"${step.kind === "python" ? " selected" : ""}>Python</option>
              </select>
              <span class="workflow-step-authority authority-${stepAuthority(step).toLowerCase()}">${stepAuthority(step)}</span>
              <div class="workflow-step-actions">
                <button type="button" data-workflow-step-index="${index}" data-workflow-step-action="up" aria-label="Move step up"${index === 0 ? " disabled" : ""}>↑</button>
                <button type="button" data-workflow-step-index="${index}" data-workflow-step-action="down" aria-label="Move step down"${index === this.#steps.length - 1 ? " disabled" : ""}>↓</button>
                <button type="button" data-workflow-step-index="${index}" data-workflow-step-action="remove" aria-label="Remove step">×</button>
              </div>
            </div>
            <div class="workflow-step-controls">${controls}</div>
          </div>
        </article>
      `;
    }).join("");
    if (focus !== null) {
      const index = Math.min(focus.index, this.#steps.length - 1);
      const base = `[data-workflow-step-index="${index}"]`;
      const control = focus.field !== undefined
        ? `${base}[data-workflow-step-field="${focus.field}"]`
        : `${base}[data-workflow-step-action="${focus.action}"]:not(:disabled)`;
      (container.querySelector<HTMLElement>(control) ??
        container.querySelector<HTMLElement>(`${base}[data-workflow-step-field="kind"]`))?.focus({ preventScroll: true });
    }
  }

  #renderValidation(): void {
    requiredElement<HTMLButtonElement>("#workflow-undo").disabled = this.#undo === null;
    const stepCount = this.#steps.length;
    requiredElement<HTMLElement>("#workflow-step-count").textContent = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
    const validation = requiredElement<HTMLElement>("#workflow-validation");
    const jsonStatus = requiredElement<HTMLElement>("#workflow-json-status");
    if (this.#validationError === null) {
      validation.textContent = "Workflow valid";
      validation.className = "state-text is-healthy";
      jsonStatus.textContent = "Workflow valid";
      jsonStatus.className = "is-valid";
    } else {
      validation.textContent = this.#validationError;
      validation.className = "state-text is-error";
      jsonStatus.textContent = this.#validationError;
      jsonStatus.className = "is-invalid";
    }
    this.#setRunButtonsDisabled(this.#validationError !== null);
    this.#renderImpact();
  }

  #renderImpact(): void {
    const consequential = this.#steps.filter((step) => step.kind !== "validation").length;
    const authority = requiredElement<HTMLElement>("#workflow-contract-authority");
    const approval = requiredElement<HTMLElement>("#workflow-contract-approval");
    if (consequential === 0) {
      authority.textContent = "L2 Workspace";
      authority.className = "authority-badge authority-l2";
      approval.textContent = "Direct local operator action; Web Agent authority is unchanged";
      return;
    }
    authority.textContent = "L3 Consequential";
    authority.className = "authority-badge authority-l3";
    approval.textContent = "Direct local operator action; Terminal/Python steps are consequential for Web Agent execution";
  }

  #setRunButtonsDisabled(disabled: boolean): void {
    requiredElement<HTMLButtonElement>("#workflow-start-secondary").disabled = disabled;
  }

  #renderTemplates(): void {
    const container = requiredElement<HTMLDivElement>("#workflow-template-list");
    requiredElement<HTMLElement>("#workflow-template-count").textContent = String(this.#templates.length);
    container.replaceChildren();
    if (this.#templates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "compact-empty";
      empty.textContent = "No templates available.";
      container.append(empty);
      return;
    }

    for (const template of this.#templates) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.workflowTemplateId = template.id;
      button.className = "workflow-template-card";
      const title = document.createElement("strong");
      title.textContent = template.label;
      const detail = document.createElement("span");
      detail.textContent = `${template.steps.length} steps`;
      const kinds = document.createElement("small");
      kinds.textContent = template.steps.map((step) => step.kind).join(" → ");
      button.append(title, detail, kinds);
      container.append(button);
    }
  }
}
