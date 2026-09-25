import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ControlPlaneController,
  isDesktopDirectToolName,
  type ApprovalDecision,
  type ApprovalPresentation,
  type ApprovalSurface,
  type ControlPlanePrompt,
  type ControlPlaneShellPort,
  type ProtectedSecretRestore,
} from "@sovereign/control-plane";
import {
  CONTROL_PROTOCOL_MAX_LINE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  isControlRequestMethod,
  parseControlProtocolMessage,
  serializeControlProtocolMessage,
  type ControlProtocolMessage,
  type ControlRequestMethod,
  type DesktopPermissionProfile,
  type DesktopRuntimeCutoverCheckpointInput,
  type DesktopRuntimeCutoverDetachInput,
  type DesktopRuntimeCutoverDrainInput,
  type DesktopRuntimeCutoverPromoteInput,
  type DesktopRuntimeCutoverResumeInput,
  type DesktopRuntimeCutoverRole,
  type DesktopRuntimeCutoverStatus,
  type DesktopRuntimeState,
  type DesktopSecureTunnelAutomationInput,
  type DesktopSecureTunnelConfigurationInput,
  type ProtocolRequest,
  type ShellRequestMethod,
} from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

import { RuntimeCutoverGate, isRuntimeCutoverMethod } from "./cutover.js";

interface PendingShellCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface HostReadyPayload {
  readonly processId: number;
  readonly state: DesktopRuntimeState;
  readonly cutover: DesktopRuntimeCutoverStatus;
}

function requiredEnvironment(name: string, maxLength = 4_096): string {
  const value = process.env[name]?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(
      `Required runtime-host environment variable is invalid: ${name}`,
    );
  }
  return value;
}

function optionalEnvironment(
  name: string,
  maxLength = 4_096,
): string | undefined {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (value.length > maxLength || /[\r\n\0]/u.test(value)) {
    throw new Error(`Runtime-host environment variable is invalid: ${name}`);
  }
  return value;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = optionalEnvironment(name, 16)?.toLowerCase();
  if (value === undefined) {
    return fallback;
  }
  if (["1", "true", "on", "yes"].includes(value)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(value)) {
    return false;
  }
  throw new Error(
    `${name} must be one of 1, true, on, yes, 0, false, off, or no.`,
  );
}

function runtimeCutoverRoleEnvironment(): DesktopRuntimeCutoverRole {
  const value = optionalEnvironment("SCR_RUNTIME_CUTOVER_ROLE", 16) ?? "active";
  if (value !== "active" && value !== "candidate") {
    throw new Error("SCR_RUNTIME_CUTOVER_ROLE must be active or candidate.");
  }
  return value;
}

function requiredParentPid(): number {
  const value = Number(requiredEnvironment("SCR_CONTROL_PARENT_PID", 16));
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error("SCR_CONTROL_PARENT_PID must be a positive process id.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 4_096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\0]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedLimit(value: unknown, fallback = 100): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, 500))
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSessionSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(
      "Runtime-host control session secret must be a 256-bit base64url value.",
    );
  }
  return value;
}

class HostProtocolChannel {
  readonly #session: string;
  readonly #pendingShell = new Map<string, PendingShellCall>();
  #buffer = "";
  #eventSequence = 0;
  #requestHandler: ((request: ProtocolRequest) => void) | null = null;
  #closeHandler: (() => void) | null = null;
  #closed = false;

  constructor(session: string) {
    this.#session = session;
  }

  start(): void {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => this.#acceptChunk(chunk));
    process.stdin.on("end", () => this.#handleClosed());
    process.stdin.on("close", () => this.#handleClosed());
    process.stdin.on("error", () => this.#handleClosed());
  }

  setRequestHandler(handler: (request: ProtocolRequest) => void): void {
    this.#requestHandler = handler;
  }

  setCloseHandler(handler: () => void): void {
    this.#closeHandler = handler;
  }

  event(
    event: "host.ready" | "state.changed" | "host.log",
    payload: unknown,
  ): void {
    this.#eventSequence += 1;
    this.#write({
      v: CONTROL_PROTOCOL_VERSION,
      session: this.#session,
      kind: "event",
      sequence: this.#eventSequence,
      event,
      payload,
    });
  }

  respond(id: string, result: unknown): void {
    this.#write({
      v: CONTROL_PROTOCOL_VERSION,
      session: this.#session,
      kind: "response",
      id,
      ok: true,
      result,
    });
  }

  respondError(id: string, code: string, message: string): void {
    this.#write({
      v: CONTROL_PROTOCOL_VERSION,
      session: this.#session,
      kind: "response",
      id,
      ok: false,
      error: { code, message },
    });
  }

  callShell(
    method: ShellRequestMethod,
    params: unknown,
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Desktop shell channel is closed."));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(
        new Error("Desktop shell request was cancelled before dispatch."),
      );
    }
    const id = `host-${randomUUID()}`;
    const timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? 300_000, 300_000),
    );
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const finish = (callback: () => void): void => {
        const pending = this.#pendingShell.get(id);
        if (pending === undefined) {
          return;
        }
        this.#pendingShell.delete(id);
        clearTimeout(pending.timer);
        if (
          pending.signal !== undefined &&
          pending.abortListener !== undefined
        ) {
          pending.signal.removeEventListener("abort", pending.abortListener);
        }
        callback();
      };
      const timer = setTimeout(() => {
        finish(() =>
          rejectCall(new Error(`Desktop shell request timed out: ${method}`)),
        );
      }, timeoutMs);
      const abortListener =
        options.signal === undefined
          ? undefined
          : () => {
              this.#write({
                v: CONTROL_PROTOCOL_VERSION,
                session: this.#session,
                kind: "cancel",
                id,
              });
              finish(() =>
                rejectCall(
                  new Error(`Desktop shell request cancelled: ${method}`),
                ),
              );
            };
      this.#pendingShell.set(id, {
        resolve: (value) => finish(() => resolveCall(value)),
        reject: (error) => finish(() => rejectCall(error)),
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(abortListener === undefined ? {} : { abortListener }),
      });
      if (options.signal !== undefined && abortListener !== undefined) {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#write({
        v: CONTROL_PROTOCOL_VERSION,
        session: this.#session,
        kind: "request",
        id,
        method,
        params,
      });
    });
  }

  close(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of [...this.#pendingShell.values()]) {
      pending.reject(error);
    }
  }

  #acceptChunk(chunk: string): void {
    if (this.#closed) {
      return;
    }
    this.#buffer += chunk;
    if (
      Buffer.byteLength(this.#buffer, "utf8") >
      CONTROL_PROTOCOL_MAX_LINE_BYTES * 2
    ) {
      this.#fatal(
        new Error(
          "Runtime-host protocol input buffer exceeded the bounded limit.",
        ),
      );
      return;
    }
    while (true) {
      const newlineIndex = this.#buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      try {
        this.#handleMessage(parseControlProtocolMessage(line, this.#session));
      } catch (error) {
        this.#fatal(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  #handleMessage(message: ControlProtocolMessage): void {
    if (message.kind === "response") {
      const pending = this.#pendingShell.get(message.id);
      if (pending === undefined) {
        return;
      }
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(
          new Error(message.error?.message ?? "Desktop shell request failed."),
        );
      }
      return;
    }
    if (message.kind === "request") {
      if (this.#requestHandler === null) {
        this.respondError(
          message.id,
          "HOST_STARTING",
          "Runtime host is still starting.",
        );
        return;
      }
      this.#requestHandler(message);
      return;
    }
    if (message.kind === "cancel") {
      return;
    }
  }

  #write(message: ControlProtocolMessage): void {
    if (this.#closed) {
      throw new Error("Runtime-host protocol channel is closed.");
    }
    process.stdout.write(serializeControlProtocolMessage(message));
  }

  #fatal(error: Error): void {
    process.stderr.write(`[runtime-host protocol] ${error.message}\n`);
    this.close(error);
    this.#closeHandler?.();
  }

  #handleClosed(): void {
    if (this.#closed) {
      return;
    }
    this.close(new Error("Desktop shell protocol pipe closed."));
    this.#closeHandler?.();
  }
}

class RemoteShellPort implements ControlPlaneShellPort {
  readonly #channel: HostProtocolChannel;

  constructor(channel: HostProtocolChannel) {
    this.#channel = channel;
  }

  async chooseWorkspace(): Promise<string | null> {
    const result = await this.#channel.callShell("workspace.choose", {});
    if (result === null) {
      return null;
    }
    return requiredString(result, "Selected workspace path");
  }

  async chooseSecureTunnelExecutable(): Promise<string | null> {
    const result = await this.#channel.callShell(
      "tunnel.executable.choose",
      {},
    );
    if (result === null) {
      return null;
    }
    return requiredString(result, "Selected tunnel connector path");
  }

  async protectSecret(value: string): Promise<string | null> {
    const result = await this.#channel.callShell(
      "secret.protect",
      { value },
      { timeoutMs: 15_000 },
    );
    if (result === null) {
      return null;
    }
    return requiredString(result, "Protected secret ciphertext", 16_384);
  }

  async restoreSecret(encoded: string): Promise<ProtectedSecretRestore | null> {
    const result = await this.#channel.callShell(
      "secret.restore",
      { encoded },
      { timeoutMs: 15_000 },
    );
    if (result === null) {
      return null;
    }
    const record = requiredRecord(result, "Restored secret result");
    return {
      value: requiredString(record.value, "Restored secret value"),
      encoded: requiredString(
        record.encoded,
        "Restored secret ciphertext",
        16_384,
      ),
    };
  }

  async prompt(request: ControlPlanePrompt): Promise<number> {
    const result = await this.#channel.callShell("prompt", request);
    if (
      typeof result !== "number" ||
      !Number.isInteger(result) ||
      result < 0 ||
      result > 32
    ) {
      throw new Error("Desktop shell returned an invalid prompt response.");
    }
    return result;
  }
}

class RemoteApprovalSurface implements ApprovalSurface {
  readonly #channel: HostProtocolChannel;

  constructor(channel: HostProtocolChannel) {
    this.#channel = channel;
  }

  async present(
    request: ApprovalPresentation,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const result = await this.#channel.callShell("approval.present", request, {
      timeoutMs: 35_000,
      signal,
    });
    if (
      result !== "allow-once" &&
      result !== "deny" &&
      result !== "drop-to-l1"
    ) {
      throw new Error("Desktop shell returned an invalid approval decision.");
    }
    return result;
  }
}

const sessionSecret = validateSessionSecret(
  requiredEnvironment("SCR_CONTROL_SESSION_SECRET", 128),
);
const userDataPath = resolve(requiredEnvironment("SCR_CONTROL_USER_DATA_PATH"));
const nativeAgentPath = resolve(
  requiredEnvironment("SCR_CONTROL_NATIVE_AGENT_PATH"),
);
const packagedTunnelClientPath = optionalEnvironment(
  "SCR_CONTROL_TUNNEL_CLIENT_PATH",
);
const environmentWorkspaceRoot = optionalEnvironment("SCR_WORKSPACE_ROOT");
const runCompletionNotificationsEnabled = booleanEnvironment(
  "SCR_RUN_COMPLETION_NOTIFICATIONS",
  true,
);
const approvalSmokeReportPath = optionalEnvironment(
  "SCR_APPROVAL_SMOKE_REPORT_PATH",
);
const runtimeCutoverRole = runtimeCutoverRoleEnvironment();
const runtimeInstanceId =
  optionalEnvironment("SCR_RUNTIME_INSTANCE_ID", 256) ??
  `runtime-${process.pid}`;
const runtimeReleaseId =
  optionalEnvironment("SCR_RUNTIME_RELEASE_ID", 256) ?? "runtime-0.1.0";
const promotionFencingToken = optionalEnvironment(
  "SCR_RUNTIME_PROMOTION_FENCING_TOKEN",
  128,
);
const configuredGatewayBearerToken = optionalEnvironment(
  "SCR_RUNTIME_GATEWAY_BEARER_TOKEN",
  128,
);
const gatewayBearerToken =
  configuredGatewayBearerToken === undefined
    ? undefined
    : validateSessionSecret(configuredGatewayBearerToken);
const parentPid = requiredParentPid();
const channel = new HostProtocolChannel(sessionSecret);
channel.start();

let controller: ControlPlaneController | null = null;
let cutoverGate: RuntimeCutoverGate | null = null;
let shuttingDown = false;
let shutdownCompleted = false;

async function shutdownAndExit(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    if (!shutdownCompleted) {
      await controller?.shutdown();
      shutdownCompleted = true;
    }
  } catch (error) {
    process.stderr.write(`[runtime-host shutdown] ${errorMessage(error)}\n`);
  } finally {
    channel.close(new Error("Runtime host is shutting down."));
    process.exit(exitCode);
  }
}

channel.setCloseHandler(() => {
  void shutdownAndExit(0);
});

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    void shutdownAndExit(0);
  }
}, 2_000);
parentWatch.unref();

async function runApprovalSmoke(outputPath: string): Promise<void> {
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + 30_000);
  let decision: unknown = "deny";
  let error: string | null = null;
  try {
    decision = await channel.callShell(
      "approval.present",
      {
        id: `approval-smoke-${randomUUID()}`,
        toolName: "terminal.start",
        title: "L3 Consequential · Approval smoke",
        message: "Allow this synthetic approval smoke request?",
        detail:
          "This does not execute a real tool. It only validates the Tauri approval window, command capability, request binding, and close lifecycle.",
        requestedAt: requestedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        burstDetected: false,
      },
      { timeoutMs: 35_000 },
    );
  } catch (caught) {
    error = errorMessage(caught);
  }
  const passed = decision === "allow-once" && error === null;
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    `${JSON.stringify(
      {
        schemaVersion: "scr.approval-smoke/v1",
        passed,
        decision,
        error,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await shutdownAndExit(passed ? 0 : 1);
}

function requiredCutoverGate(): RuntimeCutoverGate {
  if (cutoverGate === null) {
    throw new Error("Runtime cutover gate is not initialized.");
  }
  return cutoverGate;
}

async function dispatchCutoverRequest(
  method: ControlRequestMethod,
  params: unknown,
): Promise<unknown> {
  const gate = requiredCutoverGate();
  switch (method) {
    case "cutover.status":
      return gate.status();
    case "cutover.quiesce":
      return gate.quiesce();
    case "cutover.drain": {
      const record = requiredRecord(params, "Runtime cutover drain parameters");
      const input: DesktopRuntimeCutoverDrainInput = {
        controlGeneration: record.controlGeneration as number,
        gatewayGeneration: record.gatewayGeneration as number | null,
        timeoutMs: record.timeoutMs as number,
      };
      return await gate.drain(input);
    }
    case "cutover.checkpoint": {
      const record = requiredRecord(
        params,
        "Runtime cutover checkpoint parameters",
      );
      const input: DesktopRuntimeCutoverCheckpointInput = {
        controlGeneration: record.controlGeneration as number,
        gatewayGeneration: record.gatewayGeneration as number | null,
        fencingToken: record.fencingToken as string,
      };
      return await gate.checkpoint(input);
    }
    case "cutover.detach": {
      const record = requiredRecord(
        params,
        "Runtime cutover detach parameters",
      );
      const input: DesktopRuntimeCutoverDetachInput = {
        controlGeneration: record.controlGeneration as number,
        gatewayGeneration: record.gatewayGeneration as number | null,
        checkpointId: requiredString(
          record.checkpointId,
          "Runtime cutover checkpoint id",
          256,
        ),
        fencingToken: requiredString(
          record.fencingToken,
          "Runtime cutover fencing token",
          128,
        ),
      };
      return await gate.detach(input);
    }
    case "cutover.resume": {
      const record = requiredRecord(
        params,
        "Runtime cutover resume parameters",
      );
      const input: DesktopRuntimeCutoverResumeInput = {
        controlGeneration: record.controlGeneration as number,
        gatewayGeneration: record.gatewayGeneration as number | null,
      };
      return await gate.resume(input);
    }
    case "cutover.promote": {
      const record = requiredRecord(
        params,
        "Runtime cutover promotion parameters",
      );
      const input: DesktopRuntimeCutoverPromoteInput = {
        checkpointId: requiredString(
          record.checkpointId,
          "Runtime cutover checkpoint id",
          256,
        ),
        fencingToken: requiredString(
          record.fencingToken,
          "Runtime cutover fencing token",
          128,
        ),
        externalRouteDesired: record.externalRouteDesired as boolean,
      };
      return await gate.promote(input);
    }
    case "cutover.canary":
      return await gate.canary();
  }
  throw new Error(`Unknown runtime cutover method: ${method}`);
}

async function dispatchControlRequest(
  method: ControlRequestMethod,
  params: unknown,
): Promise<unknown> {
  if (isRuntimeCutoverMethod(method)) {
    return await dispatchCutoverRequest(method, params);
  }
  const active = controller;
  if (active === null) {
    throw new Error("Runtime control plane is not initialized.");
  }
  switch (method) {
    case "state.get":
      return active.state();
    case "runtime.start":
      return await active.start();
    case "runtime.stop":
      return await active.stop();
    case "workspace.choose":
      return await active.chooseWorkspace();
    case "project.workspaces.read":
    case "project.workspace.choose":
    case "project.workspace.select": {
      const record = requiredRecord(params, "Project workspace parameters");
      const projectId = requiredString(record.projectId, "Project id", 128);
      if (method === "project.workspaces.read") return await active.readProjectWorkspaces(projectId);
      if (method === "project.workspace.choose") return await active.chooseProjectWorkspace(projectId);
      return await active.selectProjectWorkspace(projectId, requiredString(record.workspaceId, "Workspace id", 128));
    }
    case "connection.bundle":
      return active.connectionBundle();
    case "credential.rotate":
      return await active.rotateCredentials();
    case "settings.auto-start": {
      const record = requiredRecord(params, "Auto-start parameters");
      if (typeof record.enabled !== "boolean") {
        throw new Error("Auto-start enabled must be boolean.");
      }
      return await active.setAutoStart(record.enabled);
    }
    case "settings.unattended-workspace-access": {
      const record = requiredRecord(
        params,
        "Unattended workspace access parameters",
      );
      if (typeof record.enabled !== "boolean") {
        throw new Error("Unattended workspace access enabled must be boolean.");
      }
      return await active.setUnattendedWorkspaceAccess(record.enabled,
        record.workspaceId === undefined ? undefined : requiredString(record.workspaceId, "Workspace id", 128));
    }
    case "settings.web-bridge": {
      const record = requiredRecord(params, "Web bridge parameters");
      if (record.value !== null && typeof record.value !== "string") {
        throw new Error("Web bridge value must be a string or null.");
      }
      return await active.setWebBridgeUrl(record.value as string | null);
    }
    case "tunnel.configure": {
      const record = requiredRecord(params, "Tunnel configuration");
      const tunnelId = record.tunnelId;
      const runtimeApiKey = record.runtimeApiKey;
      const clearRuntimeApiKey = record.clearRuntimeApiKey;
      const controlPlaneProxyUrl = record.controlPlaneProxyUrl;
      const clearControlPlaneProxy = record.clearControlPlaneProxy;
      const controlPlaneBackupProxyUrl = record.controlPlaneBackupProxyUrl;
      const clearControlPlaneBackupProxy = record.clearControlPlaneBackupProxy;
      const controlPlaneDirectFallbackEnabled =
        record.controlPlaneDirectFallbackEnabled;
      if (tunnelId !== null && typeof tunnelId !== "string") {
        throw new Error("Tunnel ID must be a string or null.");
      }
      if (runtimeApiKey !== undefined && typeof runtimeApiKey !== "string") {
        throw new Error(
          "Tunnel runtime API key must be a string when supplied.",
        );
      }
      if (
        clearRuntimeApiKey !== undefined &&
        typeof clearRuntimeApiKey !== "boolean"
      ) {
        throw new Error("clearRuntimeApiKey must be boolean when supplied.");
      }
      if (
        controlPlaneProxyUrl !== undefined &&
        typeof controlPlaneProxyUrl !== "string"
      ) {
        throw new Error(
          "Tunnel control-plane proxy URL must be a string when supplied.",
        );
      }
      if (
        clearControlPlaneProxy !== undefined &&
        typeof clearControlPlaneProxy !== "boolean"
      ) {
        throw new Error(
          "clearControlPlaneProxy must be boolean when supplied.",
        );
      }
      if (
        controlPlaneBackupProxyUrl !== undefined &&
        typeof controlPlaneBackupProxyUrl !== "string"
      ) {
        throw new Error(
          "Tunnel backup control-plane proxy URL must be a string when supplied.",
        );
      }
      if (
        clearControlPlaneBackupProxy !== undefined &&
        typeof clearControlPlaneBackupProxy !== "boolean"
      ) {
        throw new Error(
          "clearControlPlaneBackupProxy must be boolean when supplied.",
        );
      }
      if (
        controlPlaneDirectFallbackEnabled !== undefined &&
        typeof controlPlaneDirectFallbackEnabled !== "boolean"
      ) {
        throw new Error(
          "controlPlaneDirectFallbackEnabled must be boolean when supplied.",
        );
      }
      const input: DesktopSecureTunnelConfigurationInput = {
        tunnelId: tunnelId as string | null,
        ...(runtimeApiKey === undefined ? {} : { runtimeApiKey }),
        ...(clearRuntimeApiKey === undefined ? {} : { clearRuntimeApiKey }),
        ...(controlPlaneProxyUrl === undefined ? {} : { controlPlaneProxyUrl }),
        ...(clearControlPlaneProxy === undefined
          ? {}
          : { clearControlPlaneProxy }),
        ...(controlPlaneBackupProxyUrl === undefined
          ? {}
          : { controlPlaneBackupProxyUrl }),
        ...(clearControlPlaneBackupProxy === undefined
          ? {}
          : { clearControlPlaneBackupProxy }),
        ...(controlPlaneDirectFallbackEnabled === undefined
          ? {}
          : { controlPlaneDirectFallbackEnabled }),
      };
      return await active.configureSecureTunnel(input);
    }
    case "tunnel.automation": {
      const record = requiredRecord(params, "Tunnel automation configuration");
      if (
        typeof record.autoStart !== "boolean" ||
        typeof record.autoReconnect !== "boolean"
      ) {
        throw new Error("Tunnel automation values must be boolean.");
      }
      const input: DesktopSecureTunnelAutomationInput = {
        autoStart: record.autoStart,
        autoReconnect: record.autoReconnect,
      };
      return await active.setSecureTunnelAutomation(input);
    }
    case "tunnel.executable.choose":
      return await active.chooseSecureTunnelExecutable();
    case "tunnel.start":
      return await active.startSecureTunnel();
    case "tunnel.stop":
      return await active.stopSecureTunnel();
    case "tunnel.refresh": {
      const record = requiredRecord(params, "Tunnel refresh parameters");
      if (
        record.networkChanged !== undefined &&
        typeof record.networkChanged !== "boolean"
      ) {
        throw new Error("Tunnel refresh networkChanged must be boolean when provided.");
      }
      return await active.refreshSecureTunnel({
        networkChanged: record.networkChanged === true,
      });
    }
    case "permission.set": {
      const record = requiredRecord(params, "Permission parameters");
      const profile = record.profile;
      if (
        profile !== "observe" &&
        profile !== "workspace" &&
        profile !== "consequential" &&
        profile !== "bypass"
      ) {
        throw new Error("Unknown permission profile.");
      }
      return await active.setPermissionProfile(
        profile satisfies DesktopPermissionProfile,
        record.workspaceId === undefined ? undefined : requiredString(record.workspaceId, "Workspace id", 128),
      );
    }
    case "manifest.get":
      return active.manifest();
    case "runs.list": {
      const record = requiredRecord(params, "Runs list parameters");
      return active.runs(boundedLimit(record.limit));
    }
    case "runs.get": {
      const record = requiredRecord(params, "Run parameters");
      return active.run(requiredString(record.runId, "Run id", 128));
    }
    case "runs.cancel": {
      const record = requiredRecord(params, "Run cancellation parameters");
      return active.cancelRun(requiredString(record.runId, "Run id", 128));
    }
    case "tasks.snapshot": {
      const record = requiredRecord(params, "Task snapshot parameters");
      const offset = record.offset === undefined ? 0 : record.offset;
      const limit = record.limit === undefined ? 64 : record.limit;
      if (
        !Number.isSafeInteger(offset) ||
        (offset as number) < 0 ||
        (offset as number) > 500
      ) {
        throw new Error(
          "Task snapshot offset must be an integer from 0 through 500.",
        );
      }
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100
      ) {
        throw new Error(
          "Task snapshot limit must be an integer from 1 through 100.",
        );
      }
      return active.taskWorkspaceSnapshot(offset as number, limit as number);
    }
    case "tasks.get": {
      const record = requiredRecord(params, "Task detail parameters");
      const taskId = requiredString(record.taskId, "Task id", 128);
      const messageLimit =
        record.messageLimit === undefined
          ? 200
          : boundedLimit(record.messageLimit, 500);
      const beforeSequence = record.beforeSequence;
      if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || (beforeSequence as number) < 1)) {
        throw new Error("Conversation cursor must be a positive safe integer.");
      }
      return active.taskDetail(taskId, messageLimit, beforeSequence as number | undefined);
    }
    case "tasks.coordination.operator-inbox": {
      const record = requiredRecord(
        params,
        "Task coordination operator inbox parameters",
      );
      const taskId = requiredString(record.taskId, "Task id", 128);
      const beforeSequence = record.beforeSequence;
      const limit = record.limit === undefined ? 50 : record.limit;
      if (
        beforeSequence !== undefined &&
        (!Number.isSafeInteger(beforeSequence) ||
          (beforeSequence as number) < 1)
      ) {
        throw new Error(
          "Coordination inbox cursor must be a positive safe integer.",
        );
      }
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100
      ) {
        throw new Error(
          "Coordination inbox limit must be an integer from 1 through 100.",
        );
      }
      return active.taskCoordinationInbox(
        taskId,
        beforeSequence as number | undefined,
        limit as number,
      );
    }
    case "tasks.message.user": {
      const record = requiredRecord(params, "Task message parameters");
      return active.addTaskUserMessage(
        requiredString(record.taskId, "Task id", 128),
        requiredString(record.content, "Task message", 8_000),
      );
    }
    case "tool.invoke": {
      const record = requiredRecord(params, "Tool invocation parameters");
      const toolName = requiredString(record.toolName, "Tool name", 128);
      if (!isDesktopDirectToolName(toolName)) {
        throw new Error(`Desktop tool is not exposed: ${toolName}`);
      }
      const input = requiredRecord(record.input, "Tool input");
      return await active.invokeTool(toolName, input);
    }
    case "audit.list": {
      const record = requiredRecord(params, "Audit list parameters");
      return active.auditReceipts(boundedLimit(record.limit));
    }
    case "owned-processes.list":
      return active.ownedProcesses();
    case "shutdown": {
      await active.shutdown();
      shutdownCompleted = true;
      return { shuttingDown: true };
    }
  }
}

channel.setRequestHandler((request) => {
  void (async () => {
    let release = (): void => undefined;
    try {
      if (!isControlRequestMethod(request.method)) {
        channel.respondError(
          request.id,
          "UNKNOWN_CONTROL_METHOD",
          `Unknown control method: ${String(request.method)}`,
        );
        return;
      }
      release = requiredCutoverGate().admit(request.method);
      const result = await dispatchControlRequest(
        request.method,
        request.params,
      );
      channel.respond(request.id, result);
      if (request.method === "shutdown") {
        setTimeout(() => {
          channel.close(new Error("Runtime host shutdown completed."));
          process.exit(0);
        }, 20);
      }
    } catch (error) {
      channel.respondError(
        request.id,
        error instanceof RuntimeError ? error.code : "CONTROL_ERROR",
        errorMessage(error),
      );
    } finally {
      release();
    }
  })();
});

process.on("uncaughtException", (error) => {
  process.stderr.write(
    `[runtime-host uncaught] ${error.stack ?? error.message}\n`,
  );
  void shutdownAndExit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[runtime-host rejection] ${errorMessage(reason)}\n`);
  void shutdownAndExit(1);
});

void (async () => {
  try {
    const shell = new RemoteShellPort(channel);
    const approvalSurface = new RemoteApprovalSurface(channel);
    const active = new ControlPlaneController({
      userDataPath,
      nativeAgentPath,
      ...(packagedTunnelClientPath === undefined
        ? {}
        : { packagedTunnelClientPath: resolve(packagedTunnelClientPath) }),
      ...(environmentWorkspaceRoot === undefined
        ? {}
        : { environmentWorkspaceRoot }),
      runCompletionNotificationsEnabled,
      shell,
      approvalSurface,
      passiveCutoverCandidate: runtimeCutoverRole === "candidate",
      ...(gatewayBearerToken === undefined ? {} : { gatewayBearerToken }),
      onStateChanged: (state) => channel.event("state.changed", state),
    });
    controller = active;
    await active.initialize();
    const gate = new RuntimeCutoverGate({
      instanceId: runtimeInstanceId,
      releaseId: runtimeReleaseId,
      role: runtimeCutoverRole,
      adapter: {
        trafficStatus: () => active.getGatewayTrafficStatus(),
        quiesceTraffic: () => active.quiesceForCutover(),
        waitForTrafficIdle: (expectedGeneration, timeoutMs) =>
          active.waitForCutoverIdle(expectedGeneration, timeoutMs),
        resumeTraffic: (expectedGeneration) =>
          active.resumeGatewayAfterCutover(expectedGeneration),
        externalRouteDesired: () => active.externalRouteDesiredForCutover(),
        detachExternalTraffic: (checkpointId) =>
          active.detachExternalTrafficForCutover(checkpointId),
        resumeExternalTraffic: (checkpointId, externalRouteDesired) =>
          active.resumeExternalTrafficAfterCutover(
            checkpointId,
            externalRouteDesired,
          ),
        snapshot: () => active.snapshotForCutover(),
        promote: (checkpointId, externalRouteDesired) =>
          active.promoteCutoverCandidate(checkpointId, externalRouteDesired),
        canary: () => active.canaryForCutover(),
      },
      ...(promotionFencingToken === undefined ? {} : { promotionFencingToken }),
    });
    cutoverGate = gate;
    const ready: HostReadyPayload = {
      processId: process.pid,
      state: active.state(),
      cutover: gate.status(),
    };
    channel.event("host.ready", ready);
    if (approvalSmokeReportPath !== undefined) {
      await runApprovalSmoke(approvalSmokeReportPath);
    }
  } catch (error) {
    process.stderr.write(`[runtime-host startup] ${errorMessage(error)}\n`);
    await shutdownAndExit(1);
  }
})();
