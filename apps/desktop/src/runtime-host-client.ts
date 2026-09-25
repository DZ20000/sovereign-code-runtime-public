import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  type ApprovalDecision,
  type ApprovalPresentation,
  type ApprovalSurface,
  type ControlPlaneConnectionBundle,
  type ControlPlaneOwnedProcess,
  type ControlPlanePrompt,
  type ControlPlaneShellPort,
} from "@sovereign/control-plane";
import {
  CONTROL_PROTOCOL_MAX_LINE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  isShellRequestMethod,
  parseControlProtocolMessage,
  serializeControlProtocolMessage,
  type ControlProtocolMessage,
  type ControlRequestMethod,
  type DesktopAuditReceipt,
  type DesktopDirectToolName,
  type DesktopManifestView,
  type DesktopPermissionProfile,
  type DesktopProjectWorkspaces,
  type DesktopRunRecord,
  type DesktopRunSummary,
  type DesktopRuntimeState,
  type DesktopTaskDetail,
  type DesktopTaskWorkspaceSnapshot,
  type TaskCoordinationOperatorInbox,
  type DesktopSecureTunnelAutomationInput,
  type DesktopSecureTunnelConfigurationInput,
  type ProtocolRequest,
  type ProtocolResponse,
  type ShellRequestMethod,
} from "@sovereign/control-plane-contract";

const MAX_LOG_CHARACTERS = 32_768;

interface PendingControlCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveShellRequest {
  readonly abortController: AbortController;
}

export interface RuntimeHostClientOptions {
  readonly scriptPath: string;
  readonly userDataPath: string;
  readonly nativeAgentPath: string;
  readonly packagedTunnelClientPath?: string;
  readonly environmentWorkspaceRoot?: string;
  readonly shell: ControlPlaneShellPort;
  readonly approvalSurface: ApprovalSurface;
  readonly onStateChanged?: (state: DesktopRuntimeState) => void;
}

export interface RuntimeHostOwnedProcess {
  readonly processId: number;
  readonly role: "runtime-host" | ControlPlaneOwnedProcess["role"];
  readonly label: string;
}

function boundedAppend(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length <= MAX_LOG_CHARACTERS
    ? combined
    : combined.slice(combined.length - MAX_LOG_CHARACTERS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredString(value: unknown, label: string, maxLength = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRuntimeState(value: unknown): DesktopRuntimeState {
  if (!isRecord(value) || typeof value.phase !== "string" || typeof value.runtimeVersion !== "string") {
    throw new Error("Runtime host returned an invalid state payload.");
  }
  return value as unknown as DesktopRuntimeState;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await new Promise<void>((resolveStop) => {
      const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      const timer = setTimeout(() => {
        child.kill();
        resolveStop();
      }, 3_000);
      killer.once("error", () => {
        clearTimeout(timer);
        child.kill();
        resolveStop();
      });
      killer.once("close", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
    return;
  }
  child.kill();
}

export class RuntimeHostClient {
  readonly #options: RuntimeHostClientOptions;
  readonly #sessionSecret = randomBytes(32).toString("base64url");
  readonly #pendingControl = new Map<string, PendingControlCall>();
  readonly #activeShellRequests = new Map<string, ActiveShellRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = "";
  #logTail = "";
  #state: DesktopRuntimeState | null = null;
  #lastEventSequence = 0;
  #readyResolve: ((state: DesktopRuntimeState) => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #expectedShutdown = false;

  constructor(options: RuntimeHostClientOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    if (this.#child !== null && this.#child.exitCode === null && this.#state !== null) {
      return;
    }
    this.#expectedShutdown = false;
    this.#buffer = "";
    this.#logTail = "";
    this.#lastEventSequence = 0;

    const child = spawn(process.execPath, [this.#options.scriptPath], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SCR_CONTROL_SESSION_SECRET: this.#sessionSecret,
        SCR_CONTROL_USER_DATA_PATH: this.#options.userDataPath,
        SCR_CONTROL_NATIVE_AGENT_PATH: this.#options.nativeAgentPath,
        SCR_CONTROL_PARENT_PID: String(process.pid),
        ...(this.#options.packagedTunnelClientPath === undefined
          ? {}
          : { SCR_CONTROL_TUNNEL_CLIENT_PATH: this.#options.packagedTunnelClientPath }),
        ...(this.#options.environmentWorkspaceRoot === undefined
          ? {}
          : { SCR_WORKSPACE_ROOT: this.#options.environmentWorkspaceRoot }),
      },
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#acceptChunk(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#logTail = boundedAppend(this.#logTail, chunk);
    });
    child.once("error", (error) => this.#handleChildFailure(error));
    child.once("close", (exitCode, signal) => {
      this.#handleChildClose(exitCode, signal);
    });

    await new Promise<DesktopRuntimeState>((resolveReady, rejectReady) => {
      this.#readyResolve = resolveReady;
      this.#readyReject = rejectReady;
      this.#readyTimer = setTimeout(() => {
        this.#readyTimer = null;
        this.#readyResolve = null;
        this.#readyReject = null;
        rejectReady(new Error(`Runtime host did not become ready within 20 seconds. ${this.#logTail}`.trim()));
      }, 20_000);
    });
  }

  state(): DesktopRuntimeState {
    if (this.#state === null) {
      throw new Error("Runtime host has not completed initialization.");
    }
    return this.#state;
  }

  processId(): number | null {
    const child = this.#child;
    return child !== null && child.exitCode === null ? child.pid ?? null : null;
  }

  logTail(): string {
    return this.#logTail;
  }

  async start(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("runtime.start", {}));
  }

  async stop(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("runtime.stop", {}));
  }

  async chooseWorkspace(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("workspace.choose", {}));
  }
  async readProjectWorkspaces(projectId: string): Promise<DesktopProjectWorkspaces> {
    return await this.#call("project.workspaces.read", { projectId }) as DesktopProjectWorkspaces;
  }
  async chooseProjectWorkspace(projectId: string): Promise<DesktopProjectWorkspaces> {
    return await this.#call("project.workspace.choose", { projectId }) as DesktopProjectWorkspaces;
  }
  async selectProjectWorkspace(projectId: string, workspaceId: string): Promise<DesktopProjectWorkspaces> {
    return await this.#call("project.workspace.select", { projectId, workspaceId }) as DesktopProjectWorkspaces;
  }

  async connectionBundle(): Promise<ControlPlaneConnectionBundle> {
    const result = requiredRecord(await this.#call("connection.bundle", {}), "Connection bundle");
    const endpoint = requiredString(result.endpoint, "Connection bundle endpoint");
    const target = result.target;
    if (target !== "local" && target !== "web-bridge") {
      throw new Error("Runtime host returned an invalid connection bundle target.");
    }
    return {
      endpoint,
      target,
      serialized: requiredString(result.serialized, "Serialized connection bundle", 65_536),
    };
  }

  async rotateCredentials(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("credential.rotate", {}));
  }

  async setAutoStart(enabled: boolean): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("settings.auto-start", { enabled }));
  }

  async setUnattendedWorkspaceAccess(enabled: boolean, workspaceId?: string): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("settings.unattended-workspace-access", { enabled, ...(workspaceId === undefined ? {} : { workspaceId }) }));
  }

  async setWebBridgeUrl(value: string | null): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("settings.web-bridge", { value }));
  }

  async configureSecureTunnel(
    input: DesktopSecureTunnelConfigurationInput,
  ): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("tunnel.configure", input));
  }

  async setSecureTunnelAutomation(
    input: DesktopSecureTunnelAutomationInput,
  ): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("tunnel.automation", input));
  }

  async chooseSecureTunnelExecutable(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("tunnel.executable.choose", {}));
  }

  async startSecureTunnel(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("tunnel.start", {}));
  }

  async stopSecureTunnel(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("tunnel.stop", {}));
  }

  async refreshSecureTunnel(): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("tunnel.refresh", {}));
  }

  async setPermissionProfile(profile: DesktopPermissionProfile, workspaceId?: string): Promise<DesktopRuntimeState> {
    return asRuntimeState(await this.#call("permission.set", { profile, ...(workspaceId === undefined ? {} : { workspaceId }) }));
  }

  async manifest(): Promise<DesktopManifestView | null> {
    const result = await this.#call("manifest.get", {});
    return result === null ? null : result as DesktopManifestView;
  }

  async runs(limit: number): Promise<readonly DesktopRunSummary[]> {
    const result = await this.#call("runs.list", { limit });
    if (!Array.isArray(result)) {
      throw new Error("Runtime host returned an invalid run list.");
    }
    return result as readonly DesktopRunSummary[];
  }

  async run(runId: string): Promise<DesktopRunRecord> {
    return await this.#call("runs.get", { runId }) as DesktopRunRecord;
  }

  async cancelRun(runId: string): Promise<DesktopRunRecord> {
    return await this.#call("runs.cancel", { runId }) as DesktopRunRecord;
  }

  async taskWorkspaceSnapshot(
    offset = 0,
    limit = 64,
  ): Promise<DesktopTaskWorkspaceSnapshot> {
    return await this.#call("tasks.snapshot", { offset, limit }) as DesktopTaskWorkspaceSnapshot;
  }

  async taskDetail(taskId: string, messageLimit = 200, beforeSequence?: number): Promise<DesktopTaskDetail> {
    return await this.#call("tasks.get", { taskId, messageLimit, ...(beforeSequence === undefined ? {} : { beforeSequence }) }) as DesktopTaskDetail;
  }

  async taskCoordinationInbox(
    taskId: string,
    beforeSequence?: number,
    limit = 50,
  ): Promise<TaskCoordinationOperatorInbox> {
    return await this.#call("tasks.coordination.operator-inbox", {
      taskId,
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit,
    }) as TaskCoordinationOperatorInbox;
  }

  async addTaskUserMessage(taskId: string, content: string): Promise<DesktopTaskDetail> {
    return await this.#call("tasks.message.user", { taskId, content }) as DesktopTaskDetail;
  }

  async invokeTool(
    toolName: DesktopDirectToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return await this.#call("tool.invoke", { toolName, input });
  }

  async auditReceipts(limit: number): Promise<readonly DesktopAuditReceipt[]> {
    const result = await this.#call("audit.list", { limit });
    if (!Array.isArray(result)) {
      throw new Error("Runtime host returned an invalid audit list.");
    }
    return result as readonly DesktopAuditReceipt[];
  }

  async ownedProcesses(): Promise<readonly RuntimeHostOwnedProcess[]> {
    const result = await this.#call("owned-processes.list", {});
    if (!Array.isArray(result)) {
      throw new Error("Runtime host returned an invalid owned-process list.");
    }
    const runtimeHostPid = this.processId();
    return [
      ...(runtimeHostPid === null
        ? []
        : [{ processId: runtimeHostPid, role: "runtime-host" as const, label: "Node Runtime Host" }]),
      ...(result as readonly ControlPlaneOwnedProcess[]),
    ];
  }

  async shutdown(): Promise<void> {
    const child = this.#child;
    if (child === null || child.exitCode !== null) {
      this.#clearStateAfterShutdown();
      return;
    }
    this.#expectedShutdown = true;
    try {
      await this.#call("shutdown", {}, 30_000);
    } catch {
      // Fall through to bounded process-tree termination.
    }
    await new Promise<void>((resolveClose) => {
      if (child.exitCode !== null) {
        resolveClose();
        return;
      }
      const timer = setTimeout(resolveClose, 3_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
    if (child.exitCode === null) {
      await terminateProcessTree(child);
    }
    this.#clearStateAfterShutdown();
  }

  #call(method: ControlRequestMethod, params: unknown, timeoutMs = 310_000): Promise<unknown> {
    const child = this.#child;
    if (child === null || child.exitCode !== null) {
      return Promise.reject(new Error("Runtime host process is not running."));
    }
    const id = `shell-${randomUUID()}`;
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        const pending = this.#pendingControl.get(id);
        if (pending === undefined) {
          return;
        }
        this.#pendingControl.delete(id);
        rejectCall(new Error(`Runtime host request timed out: ${method}`));
      }, Math.max(1_000, Math.min(timeoutMs, 310_000)));
      this.#pendingControl.set(id, {
        resolve: (value) => {
          this.#pendingControl.delete(id);
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          this.#pendingControl.delete(id);
          clearTimeout(timer);
          rejectCall(error);
        },
        timer,
      });
      this.#write({
        v: CONTROL_PROTOCOL_VERSION,
        session: this.#sessionSecret,
        kind: "request",
        id,
        method,
        params,
      });
    });
  }

  #acceptChunk(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > CONTROL_PROTOCOL_MAX_LINE_BYTES * 2) {
      this.#handleChildFailure(new Error("Runtime host protocol output exceeded the bounded buffer limit."));
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
        this.#handleMessage(parseControlProtocolMessage(line, this.#sessionSecret));
      } catch (error) {
        this.#handleChildFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  #handleMessage(message: ControlProtocolMessage): void {
    if (message.kind === "response") {
      this.#handleControlResponse(message);
      return;
    }
    if (message.kind === "request") {
      void this.#handleShellRequest(message);
      return;
    }
    if (message.kind === "cancel") {
      this.#activeShellRequests.get(message.id)?.abortController.abort();
      return;
    }
    if (message.kind === "event") {
      if (message.sequence <= this.#lastEventSequence) {
        throw new Error("Runtime host event sequence moved backwards or repeated.");
      }
      this.#lastEventSequence = message.sequence;
      if (message.event === "state.changed") {
        const state = asRuntimeState(message.payload);
        this.#state = state;
        this.#options.onStateChanged?.(state);
        return;
      }
      if (message.event === "host.ready") {
        const payload = requiredRecord(message.payload, "Runtime host ready event");
        const state = asRuntimeState(payload.state);
        if (
          typeof payload.processId !== "number" ||
          !Number.isInteger(payload.processId) ||
          payload.processId !== this.processId()
        ) {
          throw new Error("Runtime host ready event has an invalid process id.");
        }
        this.#state = state;
        if (this.#readyTimer !== null) {
          clearTimeout(this.#readyTimer);
          this.#readyTimer = null;
        }
        const resolveReady = this.#readyResolve;
        this.#readyResolve = null;
        this.#readyReject = null;
        resolveReady?.(state);
        this.#options.onStateChanged?.(state);
        return;
      }
      if (message.event === "host.log" && typeof message.payload === "string") {
        this.#logTail = boundedAppend(this.#logTail, message.payload);
      }
    }
  }

  #handleControlResponse(message: ProtocolResponse): void {
    const pending = this.#pendingControl.get(message.id);
    if (pending === undefined) {
      return;
    }
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error?.message ?? "Runtime host request failed."));
    }
  }

  async #handleShellRequest(request: ProtocolRequest): Promise<void> {
    if (!isShellRequestMethod(request.method)) {
      this.#respondError(request.id, "UNKNOWN_SHELL_METHOD", `Unknown shell method: ${String(request.method)}`);
      return;
    }
    const abortController = new AbortController();
    this.#activeShellRequests.set(request.id, { abortController });
    try {
      const result = await this.#dispatchShellRequest(
        request.method,
        request.params,
        abortController.signal,
      );
      this.#respond(request.id, result);
    } catch (error) {
      this.#respondError(request.id, "SHELL_ERROR", messageFrom(error));
    } finally {
      this.#activeShellRequests.delete(request.id);
    }
  }

  async #dispatchShellRequest(
    method: ShellRequestMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case "workspace.choose":
        return await this.#options.shell.chooseWorkspace();
      case "tunnel.executable.choose":
        return await this.#options.shell.chooseSecureTunnelExecutable();
      case "secret.protect": {
        const record = requiredRecord(params, "Secret-protect parameters");
        return await this.#options.shell.protectSecret(requiredString(record.value, "Secret value"));
      }
      case "secret.restore": {
        const record = requiredRecord(params, "Secret-restore parameters");
        return await this.#options.shell.restoreSecret(
          requiredString(record.encoded, "Secret ciphertext", 16_384),
        );
      }
      case "prompt": {
        const record = requiredRecord(params, "Prompt parameters");
        const buttons = record.buttons;
        if (
          (record.type !== "warning" && record.type !== "question") ||
          typeof record.title !== "string" ||
          typeof record.message !== "string" ||
          typeof record.detail !== "string" ||
          !Array.isArray(buttons) ||
          !buttons.every((button) => typeof button === "string") ||
          typeof record.defaultId !== "number" ||
          typeof record.cancelId !== "number"
        ) {
          throw new Error("Runtime host sent an invalid prompt request.");
        }
        const prompt: ControlPlanePrompt = {
          type: record.type,
          title: record.title,
          message: record.message,
          detail: record.detail,
          buttons,
          defaultId: record.defaultId,
          cancelId: record.cancelId,
        };
        return await this.#options.shell.prompt(prompt);
      }
      case "approval.present": {
        const record = requiredRecord(params, "Approval presentation");
        if (
          typeof record.id !== "string" ||
          typeof record.toolName !== "string" ||
          typeof record.title !== "string" ||
          typeof record.message !== "string" ||
          typeof record.detail !== "string" ||
          typeof record.requestedAt !== "string" ||
          typeof record.expiresAt !== "string" ||
          typeof record.burstDetected !== "boolean"
        ) {
          throw new Error("Runtime host sent an invalid approval presentation.");
        }
        const approval = record as unknown as ApprovalPresentation;
        return await this.#options.approvalSurface.present(approval, signal) satisfies ApprovalDecision;
      }
    }
  }

  #respond(id: string, result: unknown): void {
    this.#write({
      v: CONTROL_PROTOCOL_VERSION,
      session: this.#sessionSecret,
      kind: "response",
      id,
      ok: true,
      result,
    });
  }

  #respondError(id: string, code: string, message: string): void {
    this.#write({
      v: CONTROL_PROTOCOL_VERSION,
      session: this.#sessionSecret,
      kind: "response",
      id,
      ok: false,
      error: { code, message },
    });
  }

  #write(message: ControlProtocolMessage): void {
    const child = this.#child;
    if (child === null || child.exitCode !== null || child.stdin.destroyed) {
      throw new Error("Runtime host protocol pipe is unavailable.");
    }
    child.stdin.write(serializeControlProtocolMessage(message));
  }

  #handleChildFailure(error: Error): void {
    const child = this.#child;
    if (child !== null && child.exitCode === null) {
      void terminateProcessTree(child);
    }
    this.#rejectAll(error);
    this.#readyReject?.(error);
    this.#readyResolve = null;
    this.#readyReject = null;
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
  }

  #handleChildClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(
      this.#expectedShutdown
        ? "Runtime host stopped."
        : `Runtime host exited unexpectedly (code ${exitCode ?? -1}, signal ${signal ?? "none"}). ${this.#logTail}`.trim(),
    );
    this.#rejectAll(error);
    this.#readyReject?.(error);
    this.#readyResolve = null;
    this.#readyReject = null;
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    if (!this.#expectedShutdown && this.#state !== null) {
      this.#state = {
        ...this.#state,
        phase: "error",
        endpoint: null,
        sessionCount: 0,
        errorMessage: error.message,
      };
      this.#options.onStateChanged?.(this.#state);
    }
    this.#child = null;
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pendingControl) {
      this.#pendingControl.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [id, active] of this.#activeShellRequests) {
      this.#activeShellRequests.delete(id);
      active.abortController.abort();
    }
  }

  #clearStateAfterShutdown(): void {
    this.#child = null;
    this.#state = null;
    this.#buffer = "";
    this.#rejectAll(new Error("Runtime host shut down."));
  }
}
