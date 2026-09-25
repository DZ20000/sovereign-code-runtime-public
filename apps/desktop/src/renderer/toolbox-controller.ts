import type {
  DesktopBrowserObservation,
  DesktopBrowserSession,
  DesktopComputerObservation,
  DesktopPythonCapabilities,
  DesktopRunRecord,
  DesktopTerminalSession,
  DesktopWorkflowStep,
  SovereignDesktopApi,
} from "../shared.js";

interface ToolboxControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "invokeTool">;
  readonly notify: (message: string, isError?: boolean) => void;
}

interface WorkflowTemplate {
  readonly id: string;
  readonly label: string;
  readonly steps: readonly DesktopWorkflowStep[];
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Toolbox UI element is missing: ${selector}`);
  }
  return element;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The Toolbox operation failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r(?!\n)/gu, "\n");
}

function bounded(value: string, maxCharacters = 100_000): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 1)}…`;
}

function integerInput(selector: string, fallback: number): number {
  const value = Number.parseInt(requiredElement<HTMLInputElement>(selector).value, 10);
  return Number.isInteger(value) ? value : fallback;
}

function setAvailabilityBadge(selector: string, available: boolean, readyLabel: string): void {
  const badge = requiredElement<HTMLElement>(selector);
  badge.textContent = available ? readyLabel : "Unavailable";
  badge.classList.toggle("mini-badge-good", available);
}

function renderScreenshot(
  selector: string,
  mediaType: string | undefined,
  base64: string | undefined,
  preserveWhenMissing = false,
): void {
  const image = requiredElement<HTMLImageElement>(selector);
  if (base64 === undefined || mediaType === undefined) {
    if (!preserveWhenMissing) {
      image.hidden = true;
      image.removeAttribute("src");
    }
    return;
  }
  image.src = `data:${mediaType};base64,${base64}`;
  image.hidden = false;
}

export class ToolboxController {
  readonly #api: ToolboxControllerOptions["api"];
  readonly #notify: ToolboxControllerOptions["notify"];
  #terminalId: string | null = null;
  #browserId: string | null = null;
  #computerRevision: string | null = null;
  #templates: readonly WorkflowTemplate[] = [];
  #refreshing = false;

  constructor(options: ToolboxControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
  }

  mount(): void {
    requiredElement<HTMLButtonElement>("#toolbox-refresh").addEventListener("click", () => {
      void this.refresh(true);
    });
    requiredElement<HTMLButtonElement>("#toolbox-terminal-create").addEventListener("click", () => {
      void this.#createTerminal();
    });
    requiredElement<HTMLButtonElement>("#toolbox-terminal-send").addEventListener("click", () => {
      void this.#sendTerminal();
    });
    requiredElement<HTMLTextAreaElement>("#toolbox-terminal-input").addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        void this.#sendTerminal();
      }
    });
    requiredElement<HTMLButtonElement>("#toolbox-terminal-resize").addEventListener("click", () => {
      void this.#resizeTerminal();
    });
    requiredElement<HTMLButtonElement>("#toolbox-terminal-close").addEventListener("click", () => {
      void this.#closeTerminal();
    });
    requiredElement<HTMLButtonElement>("#toolbox-python-run").addEventListener("click", () => {
      void this.#startPython();
    });
    requiredElement<HTMLButtonElement>("#toolbox-browser-create").addEventListener("click", () => {
      void this.#createBrowser();
    });
    requiredElement<HTMLButtonElement>("#toolbox-browser-navigate").addEventListener("click", () => {
      void this.#navigateBrowser();
    });
    requiredElement<HTMLButtonElement>("#toolbox-browser-observe").addEventListener("click", () => {
      void this.#observeBrowser();
    });
    requiredElement<HTMLButtonElement>("#toolbox-browser-evaluate").addEventListener("click", () => {
      void this.#evaluateBrowser();
    });
    requiredElement<HTMLButtonElement>("#toolbox-browser-close").addEventListener("click", () => {
      void this.#closeBrowser();
    });
    requiredElement<HTMLButtonElement>("#toolbox-workflow-run").addEventListener("click", () => {
      void this.#startWorkflow();
    });
    requiredElement<HTMLButtonElement>("#toolbox-computer-observe").addEventListener("click", () => {
      void this.#observeComputer();
    });
    requiredElement<HTMLButtonElement>("#toolbox-computer-focus").addEventListener("click", () => {
      const windowId = requiredElement<HTMLSelectElement>("#toolbox-computer-window").value;
      if (windowId.length === 0) {
        this.#notify("Select a window after observing the desktop.", true);
        return;
      }
      void this.#actComputer({ operation: "focus_window", windowId });
    });
    requiredElement<HTMLButtonElement>("#toolbox-computer-click").addEventListener("click", () => {
      void this.#actComputer({
        operation: "click",
        x: integerInput("#toolbox-computer-x", 100),
        y: integerInput("#toolbox-computer-y", 100),
      });
    });
    requiredElement<HTMLButtonElement>("#toolbox-computer-type").addEventListener("click", () => {
      const text = requiredElement<HTMLInputElement>("#toolbox-computer-text").value;
      if (text.length === 0) {
        this.#notify("Enter text to type.", true);
        return;
      }
      void this.#actComputer({ operation: "type_text", text });
    });
    requiredElement<HTMLButtonElement>("#toolbox-computer-key-send").addEventListener("click", () => {
      const key = requiredElement<HTMLInputElement>("#toolbox-computer-key").value.trim();
      if (key.length === 0) {
        this.#notify("Enter a key name.", true);
        return;
      }
      void this.#actComputer({ operation: "press_key", key });
    });
  }

  async refresh(showSuccess = false): Promise<void> {
    if (this.#refreshing) {
      return;
    }
    this.#refreshing = true;
    try {
      await Promise.all([
        this.#refreshTerminal(),
        this.#refreshPython(),
        this.#refreshBrowser(),
        this.#refreshWorkflowTemplates(),
        this.#refreshComputer(),
      ]);
      if (showSuccess) {
        this.#notify("Toolbox capabilities refreshed.");
      }
    } catch (error) {
      this.#notify(messageFrom(error), true);
    } finally {
      this.#refreshing = false;
    }
  }

  async refreshLive(): Promise<void> {
    try {
      await Promise.all([
        this.#terminalId === null ? Promise.resolve() : this.#readTerminal(),
        this.#browserId === null ? Promise.resolve() : this.#refreshBrowserSessions(),
      ]);
    } catch {
      // Periodic refresh is best effort; explicit actions surface errors.
    }
  }

  async #refreshTerminal(): Promise<void> {
    const sessions = await this.#api.invokeTool<readonly DesktopTerminalSession[]>(
      "terminal.session.list",
      {},
    );
    if (
      this.#terminalId === null ||
      !sessions.some((session) => session.id === this.#terminalId)
    ) {
      const active = sessions.find((session) => session.state === "running" || session.state === "starting");
      this.#terminalId = active?.id ?? sessions[0]?.id ?? null;
    }
    if (this.#terminalId === null) {
      this.#renderTerminal(null);
      return;
    }
    await this.#readTerminal();
  }

  async #readTerminal(): Promise<void> {
    if (this.#terminalId === null) {
      this.#renderTerminal(null);
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.read",
        { sessionId: this.#terminalId },
      );
      this.#renderTerminal(session);
    } catch (error) {
      this.#terminalId = null;
      this.#renderTerminal(null);
      throw error;
    }
  }

  #renderTerminal(session: DesktopTerminalSession | null): void {
    const active = session !== null && (session.state === "running" || session.state === "starting");
    const badge = requiredElement<HTMLElement>("#toolbox-terminal-state");
    badge.textContent = session === null
      ? "Not connected"
      : `${session.state}${session.processId === null ? "" : ` · PID ${session.processId}`}`;
    badge.classList.toggle("mini-badge-good", active);
    requiredElement<HTMLButtonElement>("#toolbox-terminal-send").disabled = !active;
    requiredElement<HTMLButtonElement>("#toolbox-terminal-resize").disabled = !active;
    requiredElement<HTMLButtonElement>("#toolbox-terminal-close").disabled = !active;
    requiredElement<HTMLButtonElement>("#toolbox-terminal-create").disabled = active;
    const output = requiredElement<HTMLElement>("#toolbox-terminal-output");
    output.textContent = session === null
      ? "Create a terminal to begin."
      : bounded(stripTerminalControl(session.output || session.error || "Terminal started; waiting for output."));
    output.scrollTop = output.scrollHeight;
  }

  async #createTerminal(): Promise<void> {
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.create",
        {
          columns: integerInput("#toolbox-terminal-columns", 120),
          rows: integerInput("#toolbox-terminal-rows", 32),
        },
      );
      this.#terminalId = session.id;
      this.#renderTerminal(session);
      this.#notify("Interactive ConPTY terminal created.");
      window.setTimeout(() => void this.#readTerminal(), 250);
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #sendTerminal(): Promise<void> {
    if (this.#terminalId === null) {
      return;
    }
    const input = requiredElement<HTMLTextAreaElement>("#toolbox-terminal-input");
    const data = input.value;
    if (data.length === 0) {
      this.#notify("Enter terminal input.", true);
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.write",
        { sessionId: this.#terminalId, data, appendEnter: true },
      );
      input.value = "";
      this.#renderTerminal(session);
      window.setTimeout(() => void this.#readTerminal(), 250);
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #resizeTerminal(): Promise<void> {
    if (this.#terminalId === null) {
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.resize",
        {
          sessionId: this.#terminalId,
          columns: integerInput("#toolbox-terminal-columns", 120),
          rows: integerInput("#toolbox-terminal-rows", 32),
        },
      );
      this.#renderTerminal(session);
      this.#notify("Terminal resized.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #closeTerminal(): Promise<void> {
    if (this.#terminalId === null) {
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.close",
        { sessionId: this.#terminalId },
      );
      this.#renderTerminal(session);
      this.#terminalId = null;
      this.#notify("Terminal closed.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #refreshPython(): Promise<void> {
    const capabilities = await this.#api.invokeTool<DesktopPythonCapabilities>(
      "python.capabilities",
      {},
    );
    const label = capabilities.available
      ? `${capabilities.implementation ?? "Python"} ${capabilities.version ?? ""}`.trim()
      : "Unavailable";
    setAvailabilityBadge("#toolbox-python-state", capabilities.available, label);
    requiredElement<HTMLButtonElement>("#toolbox-python-run").disabled = !capabilities.available;
  }

  async #startPython(): Promise<void> {
    const code = requiredElement<HTMLTextAreaElement>("#toolbox-python-code").value;
    if (code.trim().length === 0) {
      this.#notify("Enter Python code.", true);
      return;
    }
    try {
      const run = await this.#api.invokeTool<DesktopRunRecord>(
        "python.start",
        { mode: "code", code, timeoutMs: 120_000 },
      );
      requiredElement<HTMLElement>("#toolbox-python-result").textContent = `Run ${run.id.slice(0, 8)} started.`;
      this.#notify("Python run started; inspect it on Runs.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #refreshBrowser(): Promise<void> {
    const capabilities = await this.#api.invokeTool<Record<string, unknown>>(
      "browser.capabilities",
      {},
    );
    const available = capabilities.available === true;
    setAvailabilityBadge("#toolbox-browser-state", available, "Edge ready");
    requiredElement<HTMLButtonElement>("#toolbox-browser-create").disabled = !available;
    await this.#refreshBrowserSessions();
  }

  async #refreshBrowserSessions(): Promise<void> {
    const sessions = await this.#api.invokeTool<readonly DesktopBrowserSession[]>(
      "browser.session.list",
      {},
    );
    if (
      this.#browserId === null ||
      !sessions.some((session) => session.id === this.#browserId && session.state === "ready")
    ) {
      this.#browserId = sessions.find((session) => session.state === "ready")?.id ?? null;
    }
    const active = this.#browserId !== null;
    requiredElement<HTMLButtonElement>("#toolbox-browser-close").disabled = !active;
    requiredElement<HTMLButtonElement>("#toolbox-browser-navigate").disabled = !active;
    requiredElement<HTMLButtonElement>("#toolbox-browser-observe").disabled = !active;
    requiredElement<HTMLButtonElement>("#toolbox-browser-evaluate").disabled = !active;
    if (active) {
      const current = sessions.find((session) => session.id === this.#browserId);
      if (current !== undefined) {
        const badge = requiredElement<HTMLElement>("#toolbox-browser-state");
        badge.textContent = `Ready · ${current.url}`;
        badge.classList.add("mini-badge-good");
      }
    }
  }

  async #createBrowser(): Promise<void> {
    const allowedDomains = requiredElement<HTMLInputElement>("#toolbox-browser-domains")
      .value
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (allowedDomains.length === 0) {
      this.#notify("Enter at least one allowed domain.", true);
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopBrowserSession>(
        "browser.session.create",
        { allowedDomains },
      );
      this.#browserId = session.id;
      await this.#refreshBrowserSessions();
      this.#notify("Managed browser session created.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #navigateBrowser(): Promise<void> {
    if (this.#browserId === null) {
      return;
    }
    const url = requiredElement<HTMLInputElement>("#toolbox-browser-url").value.trim();
    try {
      const observation = await this.#api.invokeTool<DesktopBrowserObservation>(
        "browser.navigate",
        { sessionId: this.#browserId, url },
      );
      this.#renderBrowserObservation(observation);
      this.#notify("Managed browser navigation completed.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #observeBrowser(): Promise<void> {
    if (this.#browserId === null) {
      return;
    }
    try {
      const observation = await this.#api.invokeTool<DesktopBrowserObservation>(
        "browser.observe",
        { sessionId: this.#browserId, includeScreenshot: true },
      );
      this.#renderBrowserObservation(observation);
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  #renderBrowserObservation(observation: DesktopBrowserObservation): void {
    const accessibility = observation.accessibility
      .slice(0, 60)
      .map((node) => `${node.role}: ${node.name}`)
      .join("\n");
    requiredElement<HTMLElement>("#toolbox-browser-output").textContent = bounded(
      [
        `${observation.title || "Untitled"}\n${observation.url}\nRevision ${observation.revision}`,
        observation.text,
        accessibility.length === 0 ? "" : `\n[accessibility]\n${accessibility}`,
      ].filter((value) => value.length > 0).join("\n\n"),
    );
    renderScreenshot(
      "#toolbox-browser-shot",
      observation.screenshotMediaType,
      observation.screenshotBase64,
    );
  }

  async #evaluateBrowser(): Promise<void> {
    if (this.#browserId === null) {
      return;
    }
    const expression = requiredElement<HTMLInputElement>("#toolbox-browser-expression").value;
    try {
      const value = await this.#api.invokeTool<{ readonly result: unknown }>(
        "browser.evaluate",
        { sessionId: this.#browserId, expression },
      );
      requiredElement<HTMLElement>("#toolbox-browser-output").textContent = bounded(
        JSON.stringify(value.result, null, 2) ?? String(value.result),
      );
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #closeBrowser(): Promise<void> {
    if (this.#browserId === null) {
      return;
    }
    try {
      await this.#api.invokeTool("browser.session.close", { sessionId: this.#browserId });
      this.#browserId = null;
      requiredElement<HTMLElement>("#toolbox-browser-output").textContent = "No browser observation.";
      renderScreenshot("#toolbox-browser-shot", undefined, undefined);
      await this.#refreshBrowserSessions();
      this.#notify("Managed browser closed.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #refreshWorkflowTemplates(): Promise<void> {
    const raw = await this.#api.invokeTool<readonly unknown[]>("workflow.templates", {});
    this.#templates = raw.flatMap((value): WorkflowTemplate[] => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !Array.isArray(value.steps)) {
        return [];
      }
      return [{
        id: value.id,
        label: value.label,
        steps: value.steps as readonly DesktopWorkflowStep[],
      }];
    });
    const select = requiredElement<HTMLSelectElement>("#toolbox-workflow-template");
    const previous = select.value;
    select.replaceChildren();
    for (const template of this.#templates) {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = template.label;
      select.append(option);
    }
    if (this.#templates.some((template) => template.id === previous)) {
      select.value = previous;
    }
    setAvailabilityBadge("#toolbox-workflow-state", this.#templates.length > 0, "Templates ready");
    requiredElement<HTMLButtonElement>("#toolbox-workflow-run").disabled = this.#templates.length === 0;
  }

  async #startWorkflow(): Promise<void> {
    const selected = requiredElement<HTMLSelectElement>("#toolbox-workflow-template").value;
    const template = this.#templates.find((candidate) => candidate.id === selected);
    if (template === undefined) {
      this.#notify("Select a workflow template.", true);
      return;
    }
    try {
      const run = await this.#api.invokeTool<DesktopRunRecord>(
        "workflow.start",
        { label: template.label, steps: template.steps, timeoutMs: 900_000 },
      );
      requiredElement<HTMLElement>("#toolbox-workflow-result").textContent = `Run ${run.id.slice(0, 8)} started.`;
      this.#notify("Workflow started; inspect it on Runs.");
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  async #refreshComputer(): Promise<void> {
    const capabilities = await this.#api.invokeTool<Record<string, unknown>>(
      "computer.capabilities",
      {},
    );
    const available = capabilities.available === true;
    setAvailabilityBadge("#toolbox-computer-state", available, "Native agent ready");
    requiredElement<HTMLButtonElement>("#toolbox-computer-observe").disabled = !available;
    if (!available) {
      this.#computerRevision = null;
      this.#setComputerActionsEnabled(false);
    }
  }

  async #observeComputer(): Promise<void> {
    try {
      const observation = await this.#api.invokeTool<DesktopComputerObservation>(
        "computer.observe",
        { includeScreenshot: true },
      );
      this.#renderComputerObservation(observation, false);
    } catch (error) {
      this.#notify(messageFrom(error), true);
    }
  }

  #renderComputerObservation(
    observation: DesktopComputerObservation,
    preserveScreenshot: boolean,
  ): void {
    this.#computerRevision = observation.revision;
    const select = requiredElement<HTMLSelectElement>("#toolbox-computer-window");
    const previous = select.value;
    select.replaceChildren();
    for (const window of observation.windows) {
      const option = document.createElement("option");
      option.value = window.id;
      option.textContent = `${window.title} · PID ${window.processId}`;
      select.append(option);
    }
    if (observation.windows.some((window) => window.id === previous)) {
      select.value = previous;
    }
    requiredElement<HTMLElement>("#toolbox-computer-windows").textContent = bounded(
      [
        `Revision ${observation.revision}\nScreen ${observation.virtualScreen.width}×${observation.virtualScreen.height} at ${observation.virtualScreen.x},${observation.virtualScreen.y}`,
        ...observation.windows.slice(0, 100).map((window) =>
          `${window.id} · ${window.title} · ${window.bounds.x},${window.bounds.y} ${window.bounds.width}×${window.bounds.height}`
        ),
      ].join("\n"),
    );
    renderScreenshot(
      "#toolbox-computer-shot",
      observation.screenshotMediaType,
      observation.screenshotBase64,
      preserveScreenshot,
    );
    this.#setComputerActionsEnabled(true);
    setAvailabilityBadge("#toolbox-computer-state", true, `Observed · ${observation.windows.length} windows`);
  }

  #setComputerActionsEnabled(enabled: boolean): void {
    for (const selector of [
      "#toolbox-computer-focus",
      "#toolbox-computer-click",
      "#toolbox-computer-type",
      "#toolbox-computer-key-send",
    ]) {
      requiredElement<HTMLButtonElement>(selector).disabled = !enabled;
    }
  }

  async #actComputer(action: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#computerRevision === null) {
      this.#notify("Observe the desktop immediately before acting.", true);
      return;
    }
    try {
      const observation = await this.#api.invokeTool<DesktopComputerObservation>(
        "computer.action",
        { expectedRevision: this.#computerRevision, action },
      );
      this.#renderComputerObservation(observation, true);
      this.#notify("Computer action completed and a fresh revision was captured.");
    } catch (error) {
      this.#computerRevision = null;
      this.#setComputerActionsEnabled(false);
      this.#notify(messageFrom(error), true);
    }
  }
}
