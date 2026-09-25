import type {
  DesktopBrowserElement,
  DesktopBrowserObservation,
  DesktopBrowserSession,
  SovereignDesktopApi,
} from "../shared.js";

interface BrowserControllerOptions {
  readonly api: Pick<SovereignDesktopApi, "invokeTool">;
  readonly notify: (message: string, isError?: boolean) => void;
}

interface BrowserCapabilities {
  readonly available?: unknown;
  readonly engine?: unknown;
  readonly requestInterception?: unknown;
  readonly semanticElementRefs?: unknown;
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required Browser UI element is missing: ${selector}`);
  }
  return element;
}

function parseDomains(value: string): readonly string[] {
  return [...new Set(value.split(",").map((domain) => domain.trim().toLowerCase()).filter((domain) => domain.length > 0))];
}

function normalizeDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (
    candidate.length === 0 ||
    candidate.length > 253 ||
    !/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u.test(candidate)
  ) {
    return null;
  }
  if (
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(candidate) &&
    !candidate.split(".").every((part) => Number(part) <= 255)
  ) {
    return null;
  }
  return candidate;
}

function serializeValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function elementLabel(element: DesktopBrowserElement): string {
  const identity = element.name || element.text || element.type || element.tag;
  return `[${element.ref}] ${element.role} · ${identity}`;
}

export class BrowserController {
  readonly #api: BrowserControllerOptions["api"];
  readonly #notify: BrowserControllerOptions["notify"];
  #sessions: readonly DesktopBrowserSession[] = [];
  #selectedSessionId: string | null = null;
  #lastObservation: DesktopBrowserObservation | null = null;
  #externalObservationDirty = false;
  #selectedElementRef: string | null = null;
  #available = false;
  #refreshing = false;

  constructor(options: BrowserControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
  }

  mount(): void {
    for (const selector of ["#browser-create", "#browser-create-empty"] as const) {
      requiredElement<HTMLButtonElement>(selector).addEventListener("click", () => {
        void this.create();
      });
    }
    const domainEntry = requiredElement<HTMLInputElement>("#browser-domain-entry");
    domainEntry.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        this.#addDomain(domainEntry.value);
      } else if (event.key === "Backspace" && domainEntry.value.length === 0) {
        const domains = [...parseDomains(requiredElement<HTMLInputElement>("#browser-domains").value)];
        domains.pop();
        this.#setDomains(domains);
      }
    });
    requiredElement<HTMLDivElement>("#browser-domain-chips").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-domain-remove]")
        : null;
      const domain = button?.dataset.domainRemove;
      if (domain !== undefined) {
        this.#setDomains(parseDomains(requiredElement<HTMLInputElement>("#browser-domains").value).filter((candidate) => candidate !== domain));
      }
    });
    this.#renderDomainChips();
    requiredElement<HTMLButtonElement>("#browser-refresh").addEventListener("click", () => {
      void this.refresh();
    });
    requiredElement<HTMLButtonElement>("#browser-navigate").addEventListener("click", () => {
      void this.navigate();
    });
    requiredElement<HTMLButtonElement>("#browser-observe").addEventListener("click", () => {
      void this.observe();
    });
    requiredElement<HTMLButtonElement>("#browser-click").addEventListener("click", () => {
      void this.clickSelected();
    });
    requiredElement<HTMLButtonElement>("#browser-type").addEventListener("click", () => {
      void this.typeSelected();
    });
    requiredElement<HTMLButtonElement>("#browser-evaluate").addEventListener("click", () => {
      void this.evaluate();
    });
    requiredElement<HTMLButtonElement>("#browser-close").addEventListener("click", () => {
      void this.close();
    });
    requiredElement<HTMLInputElement>("#browser-url").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.navigate();
      }
    });
    requiredElement<HTMLInputElement>("#browser-type-text").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        void this.typeSelected();
      }
    });
    requiredElement<HTMLDivElement>("#browser-session-list").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-browser-session-id]")
        : null;
      const sessionId = button?.dataset.browserSessionId;
      if (sessionId !== undefined) {
        const changed = this.#selectedSessionId !== sessionId;
        this.#selectedSessionId = sessionId;
        if (changed) {
          this.#clearObservation();
        }
        this.#renderSessions();
        const selected = this.#sessions.find((session) => session.id === sessionId) ?? null;
        this.#renderSelected(selected);
        if (selected?.state === "ready") {
          void this.observe();
        }
      }
    });
    requiredElement<HTMLDivElement>("#browser-element-list").addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>("button[data-browser-ref]")
        : null;
      const ref = button?.dataset.browserRef;
      if (ref !== undefined) {
        this.#selectedElementRef = ref;
        this.#renderElements();
        this.#renderActionState();
      }
    });
  }

  markExternalActivity(): void {
    this.#externalObservationDirty = true;
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      return;
    }
    this.#refreshing = true;
    try {
      const [capabilities, sessions] = await Promise.all([
        this.#api.invokeTool<BrowserCapabilities>("browser.capabilities", {}),
        this.#api.invokeTool<readonly DesktopBrowserSession[]>("browser.session.list", {}),
      ]);
      this.#available = capabilities.available === true;
      const badge = requiredElement<HTMLElement>("#browser-capability");
      badge.textContent = this.#available ? "Browser helper available" : "Browser helper unavailable";
      badge.className = `state-text${this.#available ? " is-healthy" : " is-error"}`;
      this.#renderCreateScope();
      this.#sessions = sessions;
      const previousSessionId = this.#selectedSessionId;
      if (
        this.#selectedSessionId === null ||
        !sessions.some((session) => session.id === this.#selectedSessionId)
      ) {
        this.#selectedSessionId = sessions[0]?.id ?? null;
      }
      if (previousSessionId !== this.#selectedSessionId) {
        this.#clearObservation();
      }
      this.#renderSessions();
      const selected = sessions.find((session) => session.id === this.#selectedSessionId) ?? null;
      this.#renderSelected(selected);
      const observationChanged = selected?.state === "ready" && (
        this.#lastObservation === null ||
        this.#lastObservation.id !== selected.id ||
        this.#lastObservation.url !== selected.url ||
        this.#lastObservation.title !== selected.title ||
        this.#lastObservation.blockedRequestCount !== selected.blockedRequestCount ||
        this.#externalObservationDirty
      );
      if (observationChanged) {
        await this.observe();
      }
    } catch (error) {
      this.#notify(
        error instanceof Error ? error.message : "Could not refresh managed browsers.",
        true,
      );
    } finally {
      this.#refreshing = false;
    }
  }

  async create(): Promise<void> {
    const domainEntry = requiredElement<HTMLInputElement>("#browser-domain-entry");
    const pendingDomain = domainEntry.value.trim();
    if (pendingDomain.length > 0) {
      const normalized = normalizeDomain(pendingDomain);
      if (normalized === null) {
        this.#notify("Enter a hostname only. Schemes, paths and ports are not allowed.", true);
        return;
      }
      this.#setDomains([
        ...parseDomains(requiredElement<HTMLInputElement>("#browser-domains").value),
        normalized,
      ]);
      domainEntry.value = "";
    }
    const allowedDomains = parseDomains(
      requiredElement<HTMLInputElement>("#browser-domains").value,
    );
    if (allowedDomains.length === 0) {
      this.#notify("Enter at least one allowed domain.", true);
      return;
    }
    try {
      const session = await this.#api.invokeTool<DesktopBrowserSession>(
        "browser.session.create",
        { allowedDomains },
      );
      this.#selectedSessionId = session.id;
      this.#clearObservation();
      this.#notify("Managed browser session created.");
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not create browser.", true);
    }
  }

  async navigate(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      return;
    }
    const url = requiredElement<HTMLInputElement>("#browser-url").value.trim();
    if (url.length === 0) {
      return;
    }
    try {
      const observation = await this.#api.invokeTool<DesktopBrowserObservation>(
        "browser.navigate",
        { sessionId, url },
      );
      this.#renderObservation(observation);
      if (requiredElement<HTMLInputElement>("#browser-screenshot-toggle").checked) {
        await this.observe();
      }
      this.#notify("Managed browser navigation completed.");
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Browser navigation failed.", true);
    }
  }

  async observe(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      return;
    }
    const includeScreenshot = requiredElement<HTMLInputElement>(
      "#browser-screenshot-toggle",
    ).checked;
    try {
      const observation = await this.#api.invokeTool<DesktopBrowserObservation>(
        "browser.observe",
        { sessionId, includeScreenshot },
      );
      this.#externalObservationDirty = false;
      this.#renderObservation(observation);
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not observe browser.", true);
    }
  }

  async clickSelected(): Promise<void> {
    const observation = this.#lastObservation;
    const ref = this.#selectedElementRef;
    if (
      observation === null ||
      ref === null ||
      observation.id !== this.#selectedSessionId
    ) {
      return;
    }
    try {
      const next = await this.#api.invokeTool<DesktopBrowserObservation>("browser.click", {
        sessionId: observation.id,
        expectedRevision: observation.revision,
        ref,
      });
      this.#renderObservation(next);
      if (requiredElement<HTMLInputElement>("#browser-screenshot-toggle").checked) {
        await this.observe();
      }
      this.#notify(`Clicked ${ref}.`);
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Browser click failed.", true);
    }
  }

  async typeSelected(): Promise<void> {
    const observation = this.#lastObservation;
    const ref = this.#selectedElementRef;
    if (
      observation === null ||
      ref === null ||
      observation.id !== this.#selectedSessionId
    ) {
      return;
    }
    const element = observation.elements.find((candidate) => candidate.ref === ref);
    if (element === undefined || !element.editable || element.disabled || element.sensitive) {
      this.#notify(
        element?.sensitive === true
          ? "Credential fields require human handoff."
          : "Select an editable browser element.",
        true,
      );
      return;
    }
    const textInput = requiredElement<HTMLInputElement>("#browser-type-text");
    const text = textInput.value;
    const replace = requiredElement<HTMLInputElement>("#browser-replace-toggle").checked;
    const submit = requiredElement<HTMLInputElement>("#browser-submit-toggle").checked;
    try {
      const next = await this.#api.invokeTool<DesktopBrowserObservation>("browser.type", {
        sessionId: observation.id,
        expectedRevision: observation.revision,
        ref,
        text,
        replace,
        submit,
      });
      textInput.value = "";
      this.#renderObservation(next);
      if (requiredElement<HTMLInputElement>("#browser-screenshot-toggle").checked) {
        await this.observe();
      }
      this.#notify(`Typed into ${ref}.`);
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Browser typing failed.", true);
    }
  }

  async evaluate(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      return;
    }
    const expression = requiredElement<HTMLInputElement>("#browser-expression").value;
    if (expression.trim().length === 0) {
      return;
    }
    try {
      const response = await this.#api.invokeTool<{ readonly result: unknown }>(
        "browser.evaluate",
        { sessionId, expression },
      );
      requiredElement<HTMLElement>("#browser-evaluation-result").textContent =
        serializeValue(response.result);
      await this.observe();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Browser evaluation failed.", true);
    }
  }

  async close(): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (sessionId === null) {
      return;
    }
    try {
      await this.#api.invokeTool<DesktopBrowserSession>("browser.session.close", { sessionId });
      this.#selectedSessionId = null;
      this.#clearObservation();
      this.#notify("Managed browser session closed.");
      await this.refresh();
    } catch (error) {
      this.#notify(error instanceof Error ? error.message : "Could not close browser.", true);
    }
  }

  #renderSessions(): void {
    const container = requiredElement<HTMLDivElement>("#browser-session-list");
    const hasSessions = this.#sessions.length > 0;
    requiredElement<HTMLElement>("#browser-session-count").textContent = `${this.#sessions.length} session${this.#sessions.length === 1 ? "" : "s"}`;
    requiredElement<HTMLElement>("#browser-empty-state").hidden = hasSessions;
    requiredElement<HTMLElement>("#browser-workspace").hidden = !hasSessions;
    requiredElement<HTMLButtonElement>("#browser-create").hidden = !hasSessions;
    container.replaceChildren();
    if (!hasSessions) {
      return;
    }

    for (const session of this.#sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.browserSessionId = session.id;
      button.className = "browser-session-row";
      button.classList.toggle("is-selected", session.id === this.#selectedSessionId);
      button.setAttribute("aria-pressed", String(session.id === this.#selectedSessionId));
      const identity = document.createElement("div");
      const title = document.createElement("strong");
      title.setAttribute("data-no-i18n", "");
      title.textContent = session.title || session.url || `Browser ${session.id.slice(0, 8)}`;
      const details = document.createElement("span");
      details.textContent = `${session.allowedDomains.join(", ")} · ${session.blockedRequestCount} blocked`;
      identity.append(title, details);
      const state = document.createElement("span");
      state.className = `run-state run-state-${session.state === "ready" ? "running" : session.state}`;
      state.textContent = session.state;
      button.append(identity, state);
      container.append(button);
    }
  }

  #renderSelected(session: DesktopBrowserSession | null): void {
    const ready = session?.state === "ready";
    requiredElement<HTMLElement>("#browser-title").toggleAttribute("data-no-i18n", session !== null);
    requiredElement<HTMLElement>("#browser-title").textContent =
      session === null ? "No session selected" : session.title || `Browser ${session.id.slice(0, 8)}`;
    const url = requiredElement<HTMLInputElement>("#browser-url");
    if (session !== null && document.activeElement !== url) {
      url.value = session.url === "about:blank" ? url.value : session.url;
    }
    url.disabled = !ready;
    requiredElement<HTMLButtonElement>("#browser-navigate").disabled = !ready;
    requiredElement<HTMLButtonElement>("#browser-observe").disabled = !ready;
    requiredElement<HTMLInputElement>("#browser-expression").disabled = !ready;
    requiredElement<HTMLButtonElement>("#browser-evaluate").disabled = !ready;
    requiredElement<HTMLButtonElement>("#browser-close").disabled = session === null;
    requiredElement<HTMLElement>("#browser-network-status").textContent =
      `${session?.blockedRequestCount ?? 0} blocked request${(session?.blockedRequestCount ?? 0) === 1 ? "" : "s"}`;
    if (session === null) {
      this.#clearObservation();
      requiredElement<HTMLElement>("#browser-text").textContent =
        "Select a session to inspect page text.";
      requiredElement<HTMLElement>("#browser-page-url").textContent = "—";
      requiredElement<HTMLElement>("#browser-revision").textContent = "—";
      this.#renderPreview(null);
    }
    this.#renderActionState();
  }

  #renderObservation(observation: DesktopBrowserObservation): void {
    this.#lastObservation = observation;
    if (!observation.elements.some((element) => element.ref === this.#selectedElementRef)) {
      this.#selectedElementRef = null;
    }
    requiredElement<HTMLElement>("#browser-title").setAttribute("data-no-i18n", "");
    requiredElement<HTMLElement>("#browser-title").textContent =
      observation.title || `Browser ${observation.id.slice(0, 8)}`;
    requiredElement<HTMLInputElement>("#browser-url").value = observation.url;
    requiredElement<HTMLElement>("#browser-page-url").setAttribute("data-no-i18n", "");
    requiredElement<HTMLElement>("#browser-page-url").textContent = observation.url;
    requiredElement<HTMLElement>("#browser-revision").textContent = observation.revision;
    requiredElement<HTMLElement>("#browser-network-status").textContent =
      `${observation.blockedRequestCount} blocked request${observation.blockedRequestCount === 1 ? "" : "s"}`;
    const accessibility = observation.accessibility
      .slice(0, 80)
      .map((node) => `[${node.role}] ${node.name}`)
      .join("\n");
    requiredElement<HTMLElement>("#browser-text").textContent = [
      observation.text || "No page text captured.",
      accessibility.length === 0 ? "" : `\n\nAccessibility\n${accessibility}`,
    ].join("");
    if (observation.screenshotBase64 !== undefined) {
      this.#renderPreview(
        `data:${observation.screenshotMediaType ?? "image/jpeg"};base64,${observation.screenshotBase64}`,
      );
    }
    this.#renderElements();
    this.#renderActionState();
  }

  #renderElements(): void {
    const container = requiredElement<HTMLDivElement>("#browser-element-list");
    const elements = this.#lastObservation?.elements ?? [];
    requiredElement<HTMLElement>("#browser-element-count").textContent =
      `${elements.length} element${elements.length === 1 ? "" : "s"}`;
    container.replaceChildren();
    if (elements.length === 0) {
      const empty = document.createElement("div");
      empty.className = "browser-preview-empty";
      empty.textContent = "No visible interactable elements were captured.";
      container.append(empty);
      return;
    }

    for (const element of elements) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.browserRef = element.ref;
      button.className = "browser-element-row";
      button.classList.toggle("is-selected", element.ref === this.#selectedElementRef);
      button.setAttribute("aria-pressed", String(element.ref === this.#selectedElementRef));
      const identity = document.createElement("div");
      const title = document.createElement("strong");
      title.setAttribute("data-no-i18n", "");
      title.textContent = elementLabel(element);
      const details = document.createElement("span");
      details.textContent = [
        element.tag,
        element.type ?? "",
        element.editable ? "editable" : "action",
        element.sensitive ? "human handoff" : "",
        element.disabled ? "disabled" : "",
      ].filter((value) => value.length > 0).join(" · ");
      identity.append(title, details);
      const badge = document.createElement("span");
      badge.className = `browser-element-badge${element.sensitive ? " is-sensitive" : ""}`;
      badge.textContent = element.sensitive ? "handoff" : element.ref;
      button.append(identity, badge);
      container.append(button);
    }
  }

  #renderActionState(): void {
    const observation = this.#lastObservation;
    const element = observation?.elements.find(
      (candidate) => candidate.ref === this.#selectedElementRef,
    ) ?? null;
    const ready = observation !== null && observation.id === this.#selectedSessionId && element !== null;
    requiredElement<HTMLElement>("#browser-selected-ref").textContent = element?.ref ?? "—";
    requiredElement<HTMLButtonElement>("#browser-click").disabled = !ready || element?.disabled === true;
    const typeAllowed = ready && element?.editable === true && element.disabled === false && !element.sensitive;
    requiredElement<HTMLInputElement>("#browser-type-text").disabled = !typeAllowed;
    requiredElement<HTMLInputElement>("#browser-replace-toggle").disabled = !typeAllowed;
    requiredElement<HTMLInputElement>("#browser-submit-toggle").disabled = !typeAllowed;
    requiredElement<HTMLButtonElement>("#browser-type").disabled = !typeAllowed;
  }

  #clearObservation(): void {
    this.#lastObservation = null;
    this.#selectedElementRef = null;
    requiredElement<HTMLElement>("#browser-element-count").textContent = "0 elements";
    requiredElement<HTMLDivElement>("#browser-element-list").replaceChildren();
    const empty = document.createElement("div");
    empty.className = "browser-preview-empty";
    empty.textContent = "Observe a page to generate element refs.";
    requiredElement<HTMLDivElement>("#browser-element-list").append(empty);
    this.#renderActionState();
  }

  #addDomain(value: string): void {
    const domain = normalizeDomain(value);
    if (domain === null) {
      this.#notify("Enter a hostname only. Schemes, paths and ports are not allowed.", true);
      return;
    }
    const domains = [...parseDomains(requiredElement<HTMLInputElement>("#browser-domains").value)];
    if (domains.includes(domain)) {
      requiredElement<HTMLInputElement>("#browser-domain-entry").value = "";
      return;
    }
    if (domains.length >= 64) {
      this.#notify("Managed browser sessions support at most 64 allowed domains.", true);
      return;
    }
    domains.push(domain);
    this.#setDomains(domains);
    requiredElement<HTMLInputElement>("#browser-domain-entry").value = "";
  }

  #setDomains(domains: readonly string[]): void {
    requiredElement<HTMLInputElement>("#browser-domains").value = [...new Set(domains)].join(",");
    this.#renderDomainChips();
    this.#renderCreateScope();
  }

  #renderDomainChips(): void {
    const container = requiredElement<HTMLDivElement>("#browser-domain-chips");
    container.replaceChildren();
    for (const domain of parseDomains(requiredElement<HTMLInputElement>("#browser-domains").value)) {
      const chip = document.createElement("span");
      chip.className = "token-chip";
      const text = document.createElement("span");
      text.textContent = domain;
      text.setAttribute("data-no-i18n", "");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.domainRemove = domain;
      remove.setAttribute("aria-label", `Remove ${domain}`);
      remove.textContent = "×";
      chip.append(text, remove);
      container.append(chip);
    }
    this.#renderCreateScope();
  }

  #renderCreateScope(): void {
    const domains = parseDomains(requiredElement<HTMLInputElement>("#browser-domains").value);
    const hasDomains = domains.length > 0;
    requiredElement<HTMLElement>("#browser-contract-scope").textContent = hasDomains
      ? `Allowed domains: ${domains.join(", ")}`
      : "No allowed domains configured";
    for (const selector of ["#browser-create", "#browser-create-empty"] as const) {
      const button = requiredElement<HTMLButtonElement>(selector);
      button.disabled = !this.#available || !hasDomains;
      button.title = !this.#available
        ? "Browser helper is unavailable."
        : hasDomains
          ? ""
          : "Add at least one allowed domain.";
    }
  }

  #renderPreview(source: string | null): void {
    const image = requiredElement<HTMLImageElement>("#browser-preview");
    const empty = requiredElement<HTMLElement>("#browser-preview-empty");
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
}
