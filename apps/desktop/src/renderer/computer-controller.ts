import type {
  DesktopComputerObservation,
  DesktopComputerWindow,
  SovereignDesktopApi,
} from "../shared.js";

interface ComputerControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "invokeTool">;
  readonly notify: (message: string, isError?: boolean) => void;
}

interface ComputerCapabilities {
  readonly available?: unknown;
  readonly operations?: unknown;
}

interface ComputerTarget {
  readonly x: number;
  readonly y: number;
  readonly relativeX: number;
  readonly relativeY: number;
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Computer UI element is missing: ${selector}`);
  }
  return element;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class ComputerController {
  readonly #api: ComputerControllerOptions["api"];
  readonly #notify: ComputerControllerOptions["notify"];
  #observation: DesktopComputerObservation | null = null;
  #selectedWindowId: string | null = null;
  #target: ComputerTarget | null = null;
  #available = false;
  #busy = false;
  #externalObservationDirty = false;

  constructor(options: ComputerControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
  }

  mount(): void {
    for (const selector of ["#computer-observe", "#computer-observe-empty"] as const) {
      requiredElement<HTMLButtonElement>(selector).addEventListener("click", () => {
        void this.observe();
      });
    }
    requiredElement<HTMLButtonElement>("#computer-focus").addEventListener("click", () => {
      const windowId = this.#selectedWindowId;
      if (windowId !== null) {
        void this.act({ operation: "focus_window", windowId });
      }
    });
    requiredElement<HTMLButtonElement>("#computer-click").addEventListener("click", () => {
      const target = this.#target;
      if (target !== null) {
        void this.act({ operation: "click", x: target.x, y: target.y });
      }
    });
    requiredElement<HTMLButtonElement>("#computer-type").addEventListener("click", () => {
      const text = requiredElement<HTMLTextAreaElement>("#computer-text").value;
      if (text.length > 0) {
        void this.act({ operation: "type_text", text });
      }
    });
    requiredElement<HTMLButtonElement>("#computer-press-key").addEventListener("click", () => {
      const key = requiredElement<HTMLInputElement>("#computer-key").value.trim();
      if (key.length > 0) {
        void this.act({ operation: "press_key", key });
      }
    });
    requiredElement<HTMLButtonElement>("#computer-launch").addEventListener("click", () => {
      const path = requiredElement<HTMLInputElement>("#computer-launch-path").value.trim();
      if (path.length > 0) {
        void this.act({ operation: "launch_application", path });
      }
    });
    requiredElement<HTMLDivElement>("#computer-window-list").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-computer-window-id]")
        : null;
      const windowId = button?.dataset.computerWindowId;
      if (windowId !== undefined) {
        this.#selectedWindowId = windowId;
        requiredElement<HTMLInputElement>("#computer-window-id").value = windowId;
        const selectedWindow = this.#observation?.windows.find((candidate) => candidate.id === windowId);
        requiredElement<HTMLElement>("#computer-selected-window-label").setAttribute("data-no-i18n", "");
        requiredElement<HTMLElement>("#computer-selected-window-label").textContent =
          selectedWindow?.title || windowId;
        this.#renderWindows(this.#observation?.windows ?? []);
        this.#renderControls();
      }
    });
    requiredElement<HTMLImageElement>("#computer-preview").addEventListener("click", (event) => {
      this.#selectTargetFromPreview(event);
    });
    for (const input of [
      requiredElement<HTMLInputElement>("#computer-x"),
      requiredElement<HTMLInputElement>("#computer-y"),
    ]) {
      input.addEventListener("change", () => this.#selectTargetFromCoordinates());
    }
  }

  markExternalActivity(): void {
    this.#externalObservationDirty = true;
  }

  async refresh(): Promise<void> {
    try {
      const capabilities = await this.#api.invokeTool<ComputerCapabilities>(
        "computer.capabilities",
        {},
      );
      this.#available = capabilities.available === true;
      const badge = requiredElement<HTMLElement>("#computer-capability");
      badge.textContent = this.#available ? "Desktop helper available" : "Desktop helper unavailable";
      badge.className = `state-text${this.#available ? " is-healthy" : " is-error"}`;
      this.#renderControls();
      if (this.#available && this.#externalObservationDirty) {
        await this.observe();
      }
    } catch (error) {
      this.#available = false;
      this.#renderControls();
      this.#notify(error instanceof Error ? error.message : "Could not inspect computer use.", true);
    }
  }

  async observe(): Promise<void> {
    if (!this.#available || this.#busy) {
      return;
    }
    this.#busy = true;
    this.#renderControls();
    const includeScreenshot = requiredElement<HTMLInputElement>(
      "#computer-screenshot-toggle",
    ).checked;
    try {
      const observation = await this.#api.invokeTool<DesktopComputerObservation>(
        "computer.observe",
        { includeScreenshot },
      );
      this.#externalObservationDirty = false;
      this.#setObservation(observation);
      this.#notify("Desktop captured. Select a target on the screenshot or choose a window.");
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Desktop observation failed.", true);
    } finally {
      this.#busy = false;
      this.#renderControls();
    }
  }

  async act(action: Readonly<Record<string, unknown>>): Promise<void> {
    const observation = this.#observation;
    if (observation === null || this.#busy) {
      this.#notify("Capture the desktop before acting.", true);
      return;
    }
    this.#busy = true;
    this.#renderControls();
    try {
      const next = await this.#api.invokeTool<DesktopComputerObservation>("computer.action", {
        expectedRevision: observation.revision,
        action,
      });
      this.#setObservation(next);
      this.#notify("Desktop action completed. The observation revision was refreshed.");
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Desktop action failed.", true);
      if (error instanceof Error && error.message.toLowerCase().includes("stale")) {
        this.#clearObservation();
      }
    } finally {
      this.#busy = false;
      this.#renderControls();
    }
  }

  #setObservation(observation: DesktopComputerObservation): void {
    this.#observation = observation;
    this.#target = null;
    this.#renderTarget();
    if (
      this.#selectedWindowId !== null &&
      !observation.windows.some((window) => window.id === this.#selectedWindowId)
    ) {
      this.#selectedWindowId = null;
      requiredElement<HTMLInputElement>("#computer-window-id").value = "";
      requiredElement<HTMLElement>("#computer-selected-window-label").removeAttribute("data-no-i18n");
      requiredElement<HTMLElement>("#computer-selected-window-label").textContent = "None selected";
    }
    requiredElement<HTMLElement>("#computer-revision").textContent =
      `${observation.revision.slice(0, 12)}…`;
    requiredElement<HTMLElement>("#computer-observation-title").textContent =
      `${observation.virtualScreen.width}×${observation.virtualScreen.height} desktop`;
    requiredElement<HTMLElement>("#computer-window-count").textContent =
      String(observation.windows.length);
    requiredElement<HTMLElement>("#computer-empty-state").hidden = true;
    requiredElement<HTMLElement>("#computer-workspace").hidden = false;
    requiredElement<HTMLButtonElement>("#computer-observe").hidden = false;
    this.#renderPreview(
      observation.screenshotBase64 === undefined
        ? null
        : `data:${observation.screenshotMediaType ?? "image/jpeg"};base64,${observation.screenshotBase64}`,
    );
    this.#renderWindows(observation.windows);
    this.#renderControls();
  }

  #clearObservation(): void {
    this.#observation = null;
    this.#target = null;
    this.#selectedWindowId = null;
    requiredElement<HTMLInputElement>("#computer-window-id").value = "";
    requiredElement<HTMLElement>("#computer-selected-window-label").removeAttribute("data-no-i18n");
    requiredElement<HTMLElement>("#computer-selected-window-label").textContent = "None selected";
    requiredElement<HTMLElement>("#computer-revision").textContent = "No revision";
    requiredElement<HTMLElement>("#computer-window-count").textContent = "0";
    requiredElement<HTMLElement>("#computer-empty-state").hidden = false;
    requiredElement<HTMLElement>("#computer-workspace").hidden = true;
    requiredElement<HTMLButtonElement>("#computer-observe").hidden = true;
    this.#renderTarget();
  }

  #selectTargetFromPreview(event: MouseEvent): void {
    const observation = this.#observation;
    const image = event.currentTarget;
    if (observation === null || !(image instanceof HTMLImageElement) || image.hidden) {
      return;
    }
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const relativeX = clamp((event.clientX - rect.left) / rect.width, 0, 0.999999);
    const relativeY = clamp((event.clientY - rect.top) / rect.height, 0, 0.999999);
    const x = observation.virtualScreen.x + Math.floor(relativeX * observation.virtualScreen.width);
    const y = observation.virtualScreen.y + Math.floor(relativeY * observation.virtualScreen.height);
    this.#target = { x, y, relativeX, relativeY };
    requiredElement<HTMLInputElement>("#computer-x").value = String(x);
    requiredElement<HTMLInputElement>("#computer-y").value = String(y);
    this.#renderTarget();
    this.#renderControls();
  }

  #selectTargetFromCoordinates(): void {
    const observation = this.#observation;
    if (observation === null) {
      return;
    }
    const x = Number(requiredElement<HTMLInputElement>("#computer-x").value);
    const y = Number(requiredElement<HTMLInputElement>("#computer-y").value);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return;
    }
    const relativeX = (x - observation.virtualScreen.x) / observation.virtualScreen.width;
    const relativeY = (y - observation.virtualScreen.y) / observation.virtualScreen.height;
    if (relativeX < 0 || relativeX >= 1 || relativeY < 0 || relativeY >= 1) {
      this.#notify("The target coordinate is outside the observed virtual desktop.", true);
      return;
    }
    this.#target = { x, y, relativeX, relativeY };
    this.#renderTarget();
    this.#renderControls();
  }

  #renderTarget(): void {
    const target = this.#target;
    const marker = requiredElement<HTMLElement>("#computer-target-marker");
    const position = requiredElement<HTMLElement>("#computer-target-position");
    if (target === null) {
      marker.hidden = true;
      position.textContent = "No click target selected";
      return;
    }
    marker.style.left = `${target.relativeX * 100}%`;
    marker.style.top = `${target.relativeY * 100}%`;
    marker.hidden = false;
    position.textContent = `${target.x}, ${target.y}`;
  }

  #renderPreview(source: string | null): void {
    const image = requiredElement<HTMLImageElement>("#computer-preview");
    const empty = requiredElement<HTMLElement>("#computer-preview-empty");
    if (source === null) {
      image.hidden = true;
      image.removeAttribute("src");
      empty.hidden = false;
      return;
    }
    image.src = source;
    image.hidden = false;
    empty.hidden = true;
  }

  #renderWindows(windows: readonly DesktopComputerWindow[]): void {
    const container = requiredElement<HTMLDivElement>("#computer-window-list");
    container.replaceChildren();
    if (windows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "compact-empty";
      empty.textContent = "No visible top-level windows.";
      container.append(empty);
      return;
    }
    for (const window of windows) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.computerWindowId = window.id;
      button.className = "computer-window-row";
      button.classList.toggle("is-selected", window.id === this.#selectedWindowId);
      button.setAttribute("aria-pressed", String(window.id === this.#selectedWindowId));
      const identity = document.createElement("div");
      const title = document.createElement("strong");
      title.setAttribute("data-no-i18n", "");
      title.textContent = window.title;
      const details = document.createElement("span");
      details.textContent =
        `PID ${window.processId} · ${window.bounds.width}×${window.bounds.height}`;
      identity.append(title, details);
      const id = document.createElement("code");
      id.textContent = window.id;
      button.append(identity, id);
      container.append(button);
    }
  }

  #renderControls(): void {
    const hasRevision = this.#observation !== null;
    const enabled = this.#available && hasRevision && !this.#busy;
    const observe = requiredElement<HTMLButtonElement>("#computer-observe");
    const observeEmpty = requiredElement<HTMLButtonElement>("#computer-observe-empty");
    observe.disabled = !this.#available || this.#busy;
    observeEmpty.disabled = !this.#available || this.#busy;
    observe.textContent = this.#busy ? "Capturing…" : "Capture again";
    observeEmpty.textContent = this.#busy ? "Capturing…" : "Capture desktop";
    requiredElement<HTMLButtonElement>("#computer-focus").disabled =
      !enabled || this.#selectedWindowId === null;
    requiredElement<HTMLButtonElement>("#computer-click").disabled = !enabled || this.#target === null;
    requiredElement<HTMLButtonElement>("#computer-type").disabled = !enabled;
    requiredElement<HTMLButtonElement>("#computer-press-key").disabled = !enabled;
    requiredElement<HTMLButtonElement>("#computer-launch").disabled = !enabled;
  }
}
