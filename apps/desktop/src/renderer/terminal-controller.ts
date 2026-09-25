import { formatTerminalOutput } from "./terminal-output.js";
import type {
  DesktopTerminalSession,
  SovereignDesktopApi,
} from "../shared.js";

interface TerminalControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "invokeTool">;
  readonly notify: (message: string, isError?: boolean) => void;
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Terminal UI element is missing: ${selector}`);
  }
  return element;
}

function isActive(session: DesktopTerminalSession): boolean {
  return session.state === "starting" || session.state === "running";
}

function formatSessionLabel(session: DesktopTerminalSession): string {
  const cwd = session.relativeCwd.length === 0 ? "workspace root" : session.relativeCwd;
  return `${cwd} · ${session.columns}×${session.rows}`;
}

export class TerminalController {
  readonly #api: TerminalControllerOptions["api"];
  readonly #notify: TerminalControllerOptions["notify"];
  #sessions: readonly DesktopTerminalSession[] = [];
  #selectedSessionId: string | null = null;
  #displayedSessionId: string | null = null;
  #refreshing = false;

  constructor(options: TerminalControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
  }

  mount(): void {
    for (const selector of ["#terminal-create", "#terminal-create-empty"] as const) {
      requiredElement<HTMLButtonElement>(selector).addEventListener("click", () => {
        void this.create();
      });
    }
    requiredElement<HTMLButtonElement>("#terminal-refresh").addEventListener("click", () => {
      void this.refresh();
    });
    requiredElement<HTMLButtonElement>("#terminal-send").addEventListener("click", () => {
      void this.send();
    });
    requiredElement<HTMLButtonElement>("#terminal-resize").addEventListener("click", () => {
      void this.resize();
    });
    requiredElement<HTMLButtonElement>("#terminal-close").addEventListener("click", () => {
      void this.close();
    });
    requiredElement<HTMLTextAreaElement>("#terminal-input").addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        void this.send();
      }
    });
    requiredElement<HTMLDivElement>("#terminal-session-list").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-terminal-session-id]")
        : null;
      const sessionId = button?.dataset.terminalSessionId;
      if (sessionId !== undefined) {
        this.#selectedSessionId = sessionId;
        this.#renderList();
        void this.#refreshSelected();
      }
    });
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      return;
    }
    this.#refreshing = true;
    try {
      this.#sessions = await this.#api.invokeTool<readonly DesktopTerminalSession[]>(
        "terminal.session.list",
        {},
      );
      if (
        this.#selectedSessionId === null ||
        !this.#sessions.some((session) => session.id === this.#selectedSessionId)
      ) {
        this.#selectedSessionId = this.#sessions[0]?.id ?? null;
      }
      this.#renderList();
      await this.#refreshSelected();
    } catch (error) {
      this.#notify(
        error instanceof Error ? error.message : "Could not refresh interactive terminals.",
        true,
      );
    } finally {
      this.#refreshing = false;
    }
  }

  async create(cwdOverride?: string): Promise<boolean> {
    const cwdInput = requiredElement<HTMLInputElement>("#terminal-cwd");
    if (cwdOverride !== undefined) cwdInput.value = cwdOverride;
    const cwd = cwdInput.value.trim();
    const columns = Number.parseInt(
      requiredElement<HTMLInputElement>("#terminal-columns").value,
      10,
    );
    const rows = Number.parseInt(requiredElement<HTMLInputElement>("#terminal-rows").value, 10);
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.create",
        { cwd, columns, rows },
      );
      this.#selectedSessionId = session.id;
      this.#notify("Interactive Command Prompt terminal created.");
      await this.refresh();
      return true;
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not create the terminal.", true);
      return false;
    }
  }

  async send(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    const input = requiredElement<HTMLTextAreaElement>("#terminal-input");
    const data = input.value;
    if (sessionId === null || data.length === 0) {
      return;
    }
    const appendEnter = requiredElement<HTMLInputElement>("#terminal-append-enter").checked;
    try {
      await this.#api.invokeTool<DesktopTerminalSession>("terminal.session.write", {
        sessionId,
        data,
        appendEnter,
      });
      input.value = "";
      await this.#refreshSelected();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not write terminal input.", true);
    }
  }

  async resize(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      return;
    }
    const columns = Number.parseInt(
      requiredElement<HTMLInputElement>("#terminal-columns").value,
      10,
    );
    const rows = Number.parseInt(requiredElement<HTMLInputElement>("#terminal-rows").value, 10);
    try {
      await this.#api.invokeTool<DesktopTerminalSession>("terminal.session.resize", {
        sessionId,
        columns,
        rows,
      });
      this.#notify("Terminal resized.");
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not resize the terminal.", true);
    }
  }

  async close(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      return;
    }
    try {
      await this.#api.invokeTool<DesktopTerminalSession>("terminal.session.close", { sessionId });
      this.#notify("Terminal close requested.");
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not close the terminal.", true);
    }
  }

  #renderList(): void {
    const container = requiredElement<HTMLDivElement>("#terminal-session-list");
    const hasSessions = this.#sessions.length > 0;
    requiredElement<HTMLElement>("#terminal-session-count").textContent = `${this.#sessions.length} session${this.#sessions.length === 1 ? "" : "s"}`;
    requiredElement<HTMLElement>("#terminal-empty-state").hidden = hasSessions;
    requiredElement<HTMLElement>("#terminal-workspace").hidden = !hasSessions;
    requiredElement<HTMLButtonElement>("#terminal-create").hidden = !hasSessions;
    container.replaceChildren();
    if (!hasSessions) {
      return;
    }

    for (const session of this.#sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.terminalSessionId = session.id;
      button.className = "terminal-session-row";
      button.classList.toggle("is-selected", session.id === this.#selectedSessionId);
      button.setAttribute("aria-pressed", String(session.id === this.#selectedSessionId));

      const identity = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `Command Prompt ${session.id.slice(0, 8)}`;
      const detail = document.createElement("span");
      detail.toggleAttribute("data-no-i18n", session.relativeCwd.length > 0);
      detail.textContent = formatSessionLabel(session);
      identity.append(title, detail);

      const state = document.createElement("span");
      state.className = `run-state run-state-${session.state === "exited" ? "succeeded" : session.state}`;
      state.textContent = session.state;
      button.append(identity, state);
      container.append(button);
    }
  }

  async #refreshSelected(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      this.#renderSelected(null);
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopTerminalSession>(
        "terminal.session.read",
        { sessionId },
      );
      if (sessionId !== this.#selectedSessionId) return;
      this.#sessions = this.#sessions.map((candidate) =>
        candidate.id === session.id ? session : candidate
      );
      this.#renderSelected(session);
    } catch (error) {
      if (sessionId !== this.#selectedSessionId) return;
      this.#renderSelected(null);
      this.#notify(error instanceof Error ? error.message : "Could not read terminal output.", true);
    }
  }

  #renderSelected(session: DesktopTerminalSession | null): void {
    const title = requiredElement<HTMLElement>("#terminal-title");
    const state = requiredElement<HTMLElement>("#terminal-state");
    const output = requiredElement<HTMLElement>("#terminal-output");
    const input = requiredElement<HTMLTextAreaElement>("#terminal-input");
    const send = requiredElement<HTMLButtonElement>("#terminal-send");
    const resize = requiredElement<HTMLButtonElement>("#terminal-resize");
    const close = requiredElement<HTMLButtonElement>("#terminal-close");

    if (session === null) {
      this.#displayedSessionId = null;
      title.removeAttribute("data-no-i18n");
      title.textContent = "No terminal selected";
      state.textContent = "No terminal selected";
      state.className = "state-text";
      output.textContent = "Create or select a terminal to inspect output.";
      input.disabled = true;
      send.disabled = true;
      resize.disabled = true;
      close.disabled = true;
      return;
    }

    const previousScrollTop = output.scrollTop;
    const followOutput = this.#displayedSessionId !== session.id ||
      output.scrollHeight - output.clientHeight - previousScrollTop <= 32;
    this.#displayedSessionId = session.id;
    const active = isActive(session);
    title.setAttribute("data-no-i18n", "");
    title.textContent = `Command Prompt · ${formatSessionLabel(session)}`;
    state.textContent = `Terminal ${session.state}`;
    state.className = `state-text${active ? " is-healthy" : ""}`;
    const nextOutput = formatTerminalOutput(session, document.documentElement.lang);
    if (output.textContent !== nextOutput) output.textContent = nextOutput;
    input.disabled = !active;
    send.disabled = !active;
    resize.disabled = !active;
    close.disabled = !active;
    output.scrollTop = followOutput ? output.scrollHeight : previousScrollTop;
  }
}
