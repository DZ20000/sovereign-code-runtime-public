import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { RuntimeError, sha256 } from "@sovereign/runtime-core";
import { sanitizedChildEnvironment } from "./process-environment.js";

export type BrowserSessionState = "starting" | "ready" | "closed" | "failed";

export interface BrowserSessionSummary {
  readonly id: string;
  readonly state: BrowserSessionState;
  readonly createdAt: string;
  readonly processId: number | null;
  readonly url: string;
  readonly title: string;
  readonly allowedDomains: readonly string[];
  readonly blockedRequestCount: number;
  readonly error: string | null;
}

export interface BrowserElementSummary {
  readonly ref: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly text: string;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly sensitive: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface BrowserObservation extends BrowserSessionSummary {
  readonly revision: string;
  readonly text: string;
  readonly accessibility: readonly {
    readonly role: string;
    readonly name: string;
  }[];
  readonly elements: readonly BrowserElementSummary[];
  readonly screenshotBase64?: string;
  readonly screenshotMediaType?: "image/jpeg";
}

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
  readonly method?: string;
  readonly params?: unknown;
}

interface CdpPending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

type CdpEventListener = (params: unknown) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageData(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("utf8");
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return String(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, CdpPending>();
  readonly #listeners = new Map<string, Set<CdpEventListener>>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      let message: CdpResponse;
      try {
        message = JSON.parse(messageData(event.data)) as CdpResponse;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
          return;
        }
        this.#pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(
            new Error(
              message.error.message ?? `CDP command failed with code ${message.error.code ?? -1}.`,
            ),
          );
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method === undefined) {
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        void Promise.resolve(listener(message.params)).catch(() => undefined);
      }
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("The managed browser CDP connection closed."));
      }
      this.#pending.clear();
      this.#listeners.clear();
    });
    socket.addEventListener("error", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("The managed browser CDP connection failed."));
      }
      this.#pending.clear();
    });
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        rejectOpen(new Error("Timed out connecting to the managed browser."));
        socket.close();
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectOpen(new Error("Could not connect to the managed browser."));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.#listeners.get(method) ?? new Set<CdpEventListener>();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(method);
      }
    };
  }

  async send<T extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("The managed browser CDP connection is not open.");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`CDP command timed out: ${method}`));
          }, timeoutMs);
        }),
      ]) as T;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    this.#socket.close();
  }
}

interface BrowserSessionMutable {
  id: string;
  state: BrowserSessionState;
  createdAt: string;
  processId: number | null;
  url: string;
  title: string;
  allowedDomains: string[];
  blockedRequestCount: number;
  error: string | null;
  revision: number;
  lastRevision: string | null;
  lastElements: Map<string, BrowserElementSummary>;
  lastBlockedNavigationUrl: string | null;
  child: ChildProcess;
  client: CdpClient | null;
  disposeNetworkPolicy: (() => void) | null;
  userDataDirectory: string;
}

interface BrowserVersionResponse {
  readonly webSocketDebuggerUrl?: string;
}

interface BrowserTargetResponse {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface BrowserPageSnapshot {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly text?: unknown;
  readonly elements?: unknown;
}

function normalizeDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (
    value.length === 0 ||
    value.length > 253 ||
    !/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u.test(value) ||
    (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value) &&
      !value.split(".").every((part) => Number(part) <= 255))
  ) {
    throw new RuntimeError("INVALID_INPUT", `Invalid browser domain: ${domain}`, 400);
  }
  return value;
}

function hostnameAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return allowedDomains.some(
    (domain) => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`),
  );
}

function assertAllowedUrl(value: string, allowedDomains: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeError("INVALID_INPUT", "Browser navigation requires a valid absolute URL.", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeError("POLICY_DENIED", "Managed browser navigation permits only HTTP and HTTPS.", 403);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new RuntimeError("POLICY_DENIED", "Managed browser URLs may not contain credentials.", 403);
  }
  if (!hostnameAllowed(url.hostname, allowedDomains)) {
    throw new RuntimeError(
      "POLICY_DENIED",
      `Domain ${url.hostname.toLowerCase()} is outside this managed browser session policy.`,
      403,
      { hostname: url.hostname.toLowerCase(), allowedDomains },
    );
  }
  return url;
}

function networkRequestAllowed(value: string, allowedDomains: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (["about:", "blob:", "data:", "devtools:"].includes(url.protocol)) {
    return true;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    return false;
  }
  return url.username.length === 0 &&
    url.password.length === 0 &&
    hostnameAllowed(url.hostname, allowedDomains);
}

function sessionSummary(session: BrowserSessionMutable): BrowserSessionSummary {
  return {
    id: session.id,
    state: session.state,
    createdAt: session.createdAt,
    processId: session.processId,
    url: session.url,
    title: session.title,
    allowedDomains: [...session.allowedDomains],
    blockedRequestCount: session.blockedRequestCount,
    error: session.error,
  };
}

function browserElement(value: unknown): BrowserElementSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const bounds = isRecord(value.bounds) ? value.bounds : null;
  if (
    typeof value.ref !== "string" ||
    !/^e\d{1,4}$/u.test(value.ref) ||
    typeof value.tag !== "string" ||
    typeof value.role !== "string" ||
    typeof value.name !== "string" ||
    typeof value.text !== "string" ||
    !(typeof value.type === "string" || value.type === null) ||
    typeof value.disabled !== "boolean" ||
    typeof value.editable !== "boolean" ||
    typeof value.sensitive !== "boolean" ||
    bounds === null ||
    typeof bounds.x !== "number" ||
    typeof bounds.y !== "number" ||
    typeof bounds.width !== "number" ||
    typeof bounds.height !== "number"
  ) {
    return null;
  }
  return {
    ref: value.ref,
    tag: value.tag,
    role: value.role,
    name: value.name,
    text: value.text,
    type: value.type,
    disabled: value.disabled,
    editable: value.editable,
    sensitive: value.sensitive,
    bounds: {
      x: bounds.x as number,
      y: bounds.y as number,
      width: bounds.width as number,
      height: bounds.height as number,
    },
  };
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a managed browser debugging port.");
  }
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function edgeExecutable(): string | null {
  const candidates = [
    process.env.SCR_BROWSER_EXECUTABLE,
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : win32.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles === undefined
      ? undefined
      : win32.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : win32.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function fetchJson<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Managed browser endpoint returned HTTP ${response.status}.`);
  }
  return await response.json() as T;
}

async function waitForTarget(port: number, child: ChildProcess): Promise<BrowserTargetResponse> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Microsoft Edge exited before CDP became ready (${child.exitCode}).`);
    }
    try {
      await fetchJson<BrowserVersionResponse>(`http://127.0.0.1:${port}/json/version`);
      const targets = await fetchJson<readonly BrowserTargetResponse[]>(
        `http://127.0.0.1:${port}/json/list`,
      );
      const page = targets.find(
        (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
      );
      if (page !== undefined) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    lastError instanceof Error
      ? `Managed browser startup timed out: ${lastError.message}`
      : "Managed browser startup timed out.",
  );
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      env: sanitizedChildEnvironment(),
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    return;
  }
  child.kill();
}

const PAGE_SNAPSHOT_EXPRESSION = String.raw`(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const labelledBy = (element) => (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const inferredRole = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (["checkbox", "radio"].includes(type)) return type;
      return "textbox";
    }
    return tag;
  };
  for (const element of document.querySelectorAll("[data-scr-ref]")) {
    element.removeAttribute("data-scr-ref");
  }
  const candidates = Array.from(document.querySelectorAll(
    "a[href],button,input:not([type='hidden']),textarea,select,[contenteditable='true'],[role='button'],[role='link'],[role='textbox'],[onclick],[tabindex]:not([tabindex='-1'])"
  )).filter((element) => element instanceof HTMLElement && visible(element)).slice(0, 300);
  const sensitivePattern = /(?:password|passcode|one[-_ ]?time|otp|verification[-_ ]?code|api[-_ ]?key|secret|token)/i;
  const elements = candidates.map((element, index) => {
    const ref = "e" + String(index + 1);
    element.setAttribute("data-scr-ref", ref);
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : null;
    const editable = tag === "textarea" || tag === "select" || element.isContentEditable || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(type || ""));
    const descriptor = [
      element.getAttribute("name") || "",
      element.id || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("autocomplete") || "",
      element.getAttribute("placeholder") || "",
      type || ""
    ].join(" ");
    const sensitive = type === "password" || sensitivePattern.test(descriptor);
    const name = (
      element.getAttribute("aria-label") ||
      labelledBy(element) ||
      element.getAttribute("alt") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      (tag === "input" && ["button", "submit", "reset"].includes(type || "") ? element.value : "") ||
      textOf(element)
    ).replace(/\s+/g, " ").trim().slice(0, 300);
    return {
      ref,
      tag,
      role: inferredRole(element),
      name,
      text: editable ? "" : textOf(element).slice(0, 300),
      type,
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      editable,
      sensitive,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  });
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 50000),
    elements
  };
})()`;

export class ManagedBrowserManager {
  readonly #sessions = new Map<string, BrowserSessionMutable>();
  #closed = false;

  available(): boolean {
    return process.platform === "win32" && edgeExecutable() !== null;
  }

  async create(allowedDomains: readonly string[]): Promise<BrowserSessionSummary> {
    if (this.#closed) {
      throw new RuntimeError("PROCESS_FAILED", "The managed browser is closed.", 503);
    }
    if (!this.available()) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Microsoft Edge was not found. Set SCR_BROWSER_EXECUTABLE to msedge.exe.",
        503,
      );
    }
    if (allowedDomains.length < 1 || allowedDomains.length > 64) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Managed browser sessions require 1 through 64 allowed domains.",
        400,
      );
    }
    const normalizedDomains = [...new Set(allowedDomains.map((domain) => normalizeDomain(domain)))];
    const id = randomUUID();
    const port = await allocatePort();
    const userDataDirectory = await mkdtemp(join(tmpdir(), `scr-browser-${id}-`));
    const executable = edgeExecutable();
    if (executable === null) {
      throw new RuntimeError("PROCESS_FAILED", "Microsoft Edge is unavailable.", 503);
    }
    const child = spawn(
      executable,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${userDataDirectory}`,
        "about:blank",
      ],
      {
        env: sanitizedChildEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      },
    );
    const session: BrowserSessionMutable = {
      id,
      state: "starting",
      createdAt: new Date().toISOString(),
      processId: child.pid ?? null,
      url: "about:blank",
      title: "",
      allowedDomains: normalizedDomains,
      blockedRequestCount: 0,
      error: null,
      revision: 0,
      lastRevision: null,
      lastElements: new Map(),
      lastBlockedNavigationUrl: null,
      child,
      client: null,
      disposeNetworkPolicy: null,
      userDataDirectory,
    };
    this.#sessions.set(id, session);
    child.once("error", (error) => {
      session.error = error.message;
      session.state = "failed";
    });
    child.once("close", (exitCode) => {
      if (exitCode !== 0 && session.state !== "closed") {
        session.state = "failed";
        session.error ??= `Microsoft Edge launcher exited with code ${exitCode}.`;
        session.disposeNetworkPolicy?.();
        session.disposeNetworkPolicy = null;
        session.client?.close();
        session.client = null;
      }
    });

    try {
      const target = await waitForTarget(port, child);
      if (target.webSocketDebuggerUrl === undefined) {
        throw new Error("Managed browser target did not expose a CDP endpoint.");
      }
      session.client = await CdpClient.connect(target.webSocketDebuggerUrl);
      session.disposeNetworkPolicy = session.client.on("Fetch.requestPaused", async (params) => {
        if (!isRecord(params) || typeof params.requestId !== "string" || !isRecord(params.request)) {
          return;
        }
        const requestUrl = params.request.url;
        if (typeof requestUrl !== "string") {
          return;
        }
        const allowed = networkRequestAllowed(requestUrl, session.allowedDomains);
        if (allowed) {
          await session.client?.send("Fetch.continueRequest", { requestId: params.requestId }, 5_000);
          return;
        }
        session.blockedRequestCount += 1;
        if (params.resourceType === "Document") {
          session.lastBlockedNavigationUrl = requestUrl;
        }
        await session.client?.send(
          "Fetch.failRequest",
          { requestId: params.requestId, errorReason: "BlockedByClient" },
          5_000,
        );
      });
      await Promise.all([
        session.client.send("Page.enable"),
        session.client.send("Runtime.enable"),
        session.client.send("Accessibility.enable"),
        session.client.send("Network.enable"),
        session.client.send("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        }),
      ]);
      session.state = "ready";
      return sessionSummary(session);
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      session.state = "failed";
      session.disposeNetworkPolicy?.();
      session.disposeNetworkPolicy = null;
      terminateProcessTree(child);
      throw new RuntimeError("PROCESS_FAILED", session.error, 500);
    }
  }

  list(): readonly BrowserSessionSummary[] {
    return [...this.#sessions.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((session) => sessionSummary(session));
  }

  async navigate(sessionId: string, targetUrl: string): Promise<BrowserObservation> {
    const session = this.#requireReady(sessionId);
    const url = assertAllowedUrl(targetUrl, session.allowedDomains);
    const client = this.#client(session);
    session.lastBlockedNavigationUrl = null;
    await client.send("Page.navigate", { url: url.toString() }, 30_000);
    await this.#waitForReady(session, 30_000);
    this.#throwBlockedNavigation(session);
    return await this.observe(sessionId, false);
  }

  async observe(sessionId: string, includeScreenshot: boolean): Promise<BrowserObservation> {
    const session = this.#requireReady(sessionId);
    const client = this.#client(session);
    const evaluated = await client.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.evaluate", {
      expression: PAGE_SNAPSHOT_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = evaluated.result?.value as BrowserPageSnapshot | undefined;
    if (isRecord(value)) {
      session.url = typeof value.url === "string" ? value.url : session.url;
      session.title = typeof value.title === "string" ? value.title : session.title;
    }
    if (session.url.startsWith("http://") || session.url.startsWith("https://")) {
      assertAllowedUrl(session.url, session.allowedDomains);
    }
    const text = isRecord(value) && typeof value.text === "string" ? value.text : "";
    const elements = isRecord(value) && Array.isArray(value.elements)
      ? value.elements.flatMap((entry) => {
          const parsed = browserElement(entry);
          return parsed === null ? [] : [parsed];
        }).slice(0, 300)
      : [];
    const accessibilityResult = await client.send<{
      readonly nodes?: readonly unknown[];
    }>("Accessibility.getFullAXTree", { depth: 5 }, 15_000);
    const accessibility = (accessibilityResult.nodes ?? [])
      .slice(0, 400)
      .flatMap((node) => {
        if (!isRecord(node)) {
          return [];
        }
        const roleRecord = isRecord(node.role) ? node.role : null;
        const nameRecord = isRecord(node.name) ? node.name : null;
        const role = roleRecord !== null && typeof roleRecord.value === "string"
          ? roleRecord.value
          : "";
        const name = nameRecord !== null && typeof nameRecord.value === "string"
          ? nameRecord.value
          : "";
        return role.length === 0 && name.length === 0 ? [] : [{ role, name }];
      });
    session.revision += 1;
    let screenshotBase64: string | undefined;
    if (includeScreenshot) {
      const screenshot = await client.send<{ readonly data?: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality: 65,
        fromSurface: true,
        captureBeyondViewport: false,
      }, 30_000);
      if (typeof screenshot.data === "string" && screenshot.data.length <= 4_000_000) {
        screenshotBase64 = screenshot.data;
      }
    }
    const revision = sha256(
      JSON.stringify({
        sessionId: session.id,
        sequence: session.revision,
        url: session.url,
        title: session.title,
        text,
        accessibility,
        elements,
        blockedRequestCount: session.blockedRequestCount,
      }),
    );
    session.lastRevision = revision;
    session.lastElements = new Map(elements.map((element) => [element.ref, element]));
    return {
      ...sessionSummary(session),
      revision,
      text,
      accessibility,
      elements,
      ...(screenshotBase64 === undefined
        ? {}
        : { screenshotBase64, screenshotMediaType: "image/jpeg" as const }),
    };
  }

  async click(
    sessionId: string,
    expectedRevision: string,
    ref: string,
  ): Promise<BrowserObservation> {
    const session = this.#requireReady(sessionId);
    const element = this.#requireElement(session, expectedRevision, ref);
    if (element.disabled) {
      throw new RuntimeError("POLICY_DENIED", "The selected browser element is disabled.", 409, { ref });
    }
    const client = this.#client(session);
    session.lastBlockedNavigationUrl = null;
    const geometry = await client.send<{
      readonly result?: { readonly value?: unknown };
    }>("Runtime.evaluate", {
      expression: `(() => {
        const element = document.querySelector(${JSON.stringify(`[data-scr-ref="${ref}"]`)});
        if (!(element instanceof HTMLElement)) return { found: false };
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          found: true,
          disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
          visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()`,
      returnByValue: true,
    });
    const value = geometry.result?.value;
    if (
      !isRecord(value) ||
      value.found !== true ||
      value.visible !== true ||
      value.disabled === true ||
      typeof value.x !== "number" ||
      typeof value.y !== "number"
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "The referenced browser element is no longer actionable. Observe the page again.",
        409,
        { ref },
      );
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: value.x,
      y: value.y,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: value.x,
      y: value.y,
      button: "left",
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: value.x,
      y: value.y,
      button: "left",
      clickCount: 1,
    });
    await delay(250);
    await this.#waitForReady(session, 15_000);
    this.#throwBlockedNavigation(session);
    return await this.observe(sessionId, false);
  }

  async type(
    sessionId: string,
    expectedRevision: string,
    ref: string,
    text: string,
    replace = true,
    submit = false,
  ): Promise<BrowserObservation> {
    if (text.length > 32_768 || text.includes("\0")) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Browser text must contain at most 32768 characters and no NUL bytes.",
        400,
      );
    }
    const session = this.#requireReady(sessionId);
    const element = this.#requireElement(session, expectedRevision, ref);
    if (!element.editable || element.disabled) {
      throw new RuntimeError("INVALID_INPUT", "The selected browser element is not editable.", 409, { ref });
    }
    if (element.sensitive) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Password, passkey, one-time-code, API-key, token, and other credential fields require human handoff.",
        403,
        { ref },
      );
    }
    const client = this.#client(session);
    session.lastBlockedNavigationUrl = null;
    const prepared = await client.send<{
      readonly result?: { readonly value?: unknown };
    }>("Runtime.evaluate", {
      expression: `(() => {
        const element = document.querySelector(${JSON.stringify(`[data-scr-ref="${ref}"]`)});
        if (!(element instanceof HTMLElement)) return { found: false };
        const tag = element.tagName.toLowerCase();
        const type = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : null;
        const descriptor = [element.getAttribute("name") || "", element.id || "", element.getAttribute("aria-label") || "", element.getAttribute("autocomplete") || "", element.getAttribute("placeholder") || "", type || ""].join(" ");
        const sensitive = type === "password" || /(?:password|passcode|one[-_ ]?time|otp|verification[-_ ]?code|api[-_ ]?key|secret|token)/i.test(descriptor);
        const editable = tag === "textarea" || tag === "select" || element.isContentEditable || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(type || ""));
        if (!editable || sensitive || Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true") return { found: true, editable, sensitive, disabled: true };
        element.focus();
        if (${replace ? "true" : "false"}) {
          if (tag === "input" || tag === "textarea") {
            const prototype = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (setter) setter.call(element, ""); else element.value = "";
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
          } else if (element.isContentEditable) {
            element.textContent = "";
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
          }
        }
        return { found: true, editable: true, sensitive: false, disabled: false };
      })()`,
      returnByValue: true,
    });
    const preparedValue = prepared.result?.value;
    if (
      !isRecord(preparedValue) ||
      preparedValue.found !== true ||
      preparedValue.editable !== true ||
      preparedValue.sensitive === true ||
      preparedValue.disabled === true
    ) {
      throw new RuntimeError(
        preparedValue !== undefined && isRecord(preparedValue) && preparedValue.sensitive === true
          ? "POLICY_DENIED"
          : "INVALID_INPUT",
        preparedValue !== undefined && isRecord(preparedValue) && preparedValue.sensitive === true
          ? "Credential fields require human handoff."
          : "The referenced browser element is no longer editable. Observe the page again.",
        preparedValue !== undefined && isRecord(preparedValue) && preparedValue.sensitive === true ? 403 : 409,
        { ref },
      );
    }
    if (text.length > 0) {
      await client.send("Input.insertText", { text }, 30_000);
    }
    if (submit) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
    await delay(250);
    await this.#waitForReady(session, 15_000);
    this.#throwBlockedNavigation(session);
    return await this.observe(sessionId, false);
  }

  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    if (expression.trim().length === 0 || expression.length > 32_768) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Browser evaluation must contain 1 through 32768 characters.",
        400,
      );
    }
    const session = this.#requireReady(sessionId);
    const client = this.#client(session);
    const result = await client.send<{
      readonly result?: {
        readonly value?: unknown;
        readonly description?: string;
      };
      readonly exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, 30_000);
    if (result.exceptionDetails !== undefined) {
      throw new RuntimeError("PROCESS_FAILED", "Browser evaluation raised an exception.", 400, {
        exceptionDetails: result.exceptionDetails,
      });
    }
    return result.result?.value ?? result.result?.description ?? null;
  }

  async close(sessionId: string): Promise<BrowserSessionSummary> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RuntimeError("RUN_NOT_FOUND", "The managed browser session was not found.", 404);
    }
    if (session.state !== "closed") {
      session.state = "closed";
      session.disposeNetworkPolicy?.();
      session.disposeNetworkPolicy = null;
      if (session.client !== null) {
        try {
          await session.client.send("Browser.close", {}, 5_000);
        } catch {
          // The browser may close the CDP socket before acknowledging Browser.close.
        }
        session.client.close();
        session.client = null;
      }
      terminateProcessTree(session.child);
    }
    await rm(session.userDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return sessionSummary(session);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.allSettled([...this.#sessions.keys()].map((sessionId) => this.close(sessionId)));
  }

  #client(session: BrowserSessionMutable): CdpClient {
    if (session.client === null) {
      throw new RuntimeError("PROCESS_FAILED", "Managed browser CDP is unavailable.", 503);
    }
    return session.client;
  }

  #requireReady(sessionId: string): BrowserSessionMutable {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RuntimeError("RUN_NOT_FOUND", "The managed browser session was not found.", 404);
    }
    if (session.state !== "ready") {
      throw new RuntimeError("PROCESS_FAILED", "The managed browser session is not ready.", 409, {
        state: session.state,
        error: session.error,
      });
    }
    return session;
  }

  #requireElement(
    session: BrowserSessionMutable,
    expectedRevision: string,
    ref: string,
  ): BrowserElementSummary {
    if (!/^[a-f0-9]{64}$/u.test(expectedRevision) || session.lastRevision !== expectedRevision) {
      throw new RuntimeError(
        "STALE_HASH",
        "The browser page changed or the observation is stale. Observe again before acting.",
        409,
        { expectedRevision, actualRevision: session.lastRevision },
      );
    }
    if (!/^e\d{1,4}$/u.test(ref)) {
      throw new RuntimeError("INVALID_INPUT", "Browser element ref must use the observed e<number> form.", 400);
    }
    const element = session.lastElements.get(ref);
    if (element === undefined) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "The browser element ref was not present in the latest observation.",
        409,
        { ref },
      );
    }
    return element;
  }

  #throwBlockedNavigation(session: BrowserSessionMutable): void {
    const blockedUrl = session.lastBlockedNavigationUrl;
    if (blockedUrl === null) {
      return;
    }
    session.lastBlockedNavigationUrl = null;
    let hostname = "unknown";
    try {
      hostname = new URL(blockedUrl).hostname.toLowerCase();
    } catch {
      // Keep the bounded fallback.
    }
    throw new RuntimeError(
      "POLICY_DENIED",
      `Managed browser navigation to ${hostname} was blocked by the session domain policy.`,
      403,
      { hostname, allowedDomains: session.allowedDomains },
    );
  }

  async #waitForReady(session: BrowserSessionMutable, timeoutMs: number): Promise<void> {
    const client = this.#client(session);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.#throwBlockedNavigation(session);
      const state = await client.send<{
        readonly result?: {
          readonly value?: unknown;
        };
      }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      }, 5_000);
      const value = state.result?.value;
      if (value === "interactive" || value === "complete") {
        return;
      }
      await delay(100);
    }
    this.#throwBlockedNavigation(session);
    throw new RuntimeError("PROCESS_TIMEOUT", "Managed browser navigation timed out.", 408);
  }
}
