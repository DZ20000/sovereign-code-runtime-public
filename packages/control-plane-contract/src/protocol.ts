export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const CONTROL_PROTOCOL_MAX_LINE_BYTES = 1_048_576;
const PROTOCOL_TEXT_ENCODER = new TextEncoder();

export const CONTROL_REQUEST_METHODS = [
  "state.get",
  "runtime.start",
  "runtime.stop",
  "workspace.choose",
  "project.workspaces.read",
  "project.workspace.choose",
  "project.workspace.select",
  "connection.bundle",
  "credential.rotate",
  "settings.auto-start",
  "settings.unattended-workspace-access",
  "settings.web-bridge",
  "tunnel.configure",
  "tunnel.automation",
  "tunnel.executable.choose",
  "tunnel.start",
  "tunnel.stop",
  "tunnel.refresh",
  "permission.set",
  "manifest.get",
  "runs.list",
  "runs.get",
  "runs.cancel",
  "tasks.snapshot",
  "tasks.get",
  "tasks.coordination.operator-inbox",
  "tasks.message.user",
  "tool.invoke",
  "audit.list",
  "owned-processes.list",
  "cutover.status",
  "cutover.quiesce",
  "cutover.drain",
  "cutover.checkpoint",
  "cutover.detach",
  "cutover.resume",
  "cutover.promote",
  "cutover.canary",
  "shutdown",
] as const;
export type ControlRequestMethod = (typeof CONTROL_REQUEST_METHODS)[number];

export const SHELL_REQUEST_METHODS = [
  "workspace.choose",
  "tunnel.executable.choose",
  "secret.protect",
  "secret.restore",
  "prompt",
  "approval.present",
] as const;
export type ShellRequestMethod = (typeof SHELL_REQUEST_METHODS)[number];

const CONTROL_REQUEST_METHOD_SET = new Set<string>(CONTROL_REQUEST_METHODS);
const SHELL_REQUEST_METHOD_SET = new Set<string>(SHELL_REQUEST_METHODS);

export function isControlRequestMethod(
  value: unknown,
): value is ControlRequestMethod {
  return typeof value === "string" && CONTROL_REQUEST_METHOD_SET.has(value);
}

export function isShellRequestMethod(
  value: unknown,
): value is ShellRequestMethod {
  return typeof value === "string" && SHELL_REQUEST_METHOD_SET.has(value);
}

export type ControlEventName = "host.ready" | "state.changed" | "host.log";

interface ProtocolEnvelope {
  readonly v: typeof CONTROL_PROTOCOL_VERSION;
  readonly session: string;
}

export interface ProtocolRequest extends ProtocolEnvelope {
  readonly kind: "request";
  readonly id: string;
  readonly method: ControlRequestMethod | ShellRequestMethod;
  readonly params: unknown;
}

export interface ProtocolResponse extends ProtocolEnvelope {
  readonly kind: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ProtocolEvent extends ProtocolEnvelope {
  readonly kind: "event";
  readonly sequence: number;
  readonly event: ControlEventName;
  readonly payload: unknown;
}

export interface ProtocolCancel extends ProtocolEnvelope {
  readonly kind: "cancel";
  readonly id: string;
}

export type ControlProtocolMessage =
  ProtocolRequest | ProtocolResponse | ProtocolEvent | ProtocolCancel;

export function isProtocolRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseControlProtocolMessage(
  source: string,
  expectedSession: string,
): ControlProtocolMessage {
  if (
    PROTOCOL_TEXT_ENCODER.encode(source).byteLength >
    CONTROL_PROTOCOL_MAX_LINE_BYTES
  ) {
    throw new Error("Control protocol message exceeds the 1 MiB limit.");
  }
  const parsed: unknown = JSON.parse(source);
  if (!isProtocolRecord(parsed)) {
    throw new Error("Control protocol message must be an object.");
  }
  if (parsed.v !== CONTROL_PROTOCOL_VERSION) {
    throw new Error("Unsupported control protocol version.");
  }
  if (parsed.session !== expectedSession) {
    throw new Error("Control protocol session secret mismatch.");
  }
  if (parsed.kind === "request") {
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length < 1 ||
      parsed.id.length > 128 ||
      typeof parsed.method !== "string" ||
      parsed.method.length < 1 ||
      parsed.method.length > 128
    ) {
      throw new Error("Control protocol request is malformed.");
    }
    return parsed as unknown as ProtocolRequest;
  }
  if (parsed.kind === "response") {
    if (typeof parsed.id !== "string" || typeof parsed.ok !== "boolean") {
      throw new Error("Control protocol response is malformed.");
    }
    return parsed as unknown as ProtocolResponse;
  }
  if (parsed.kind === "event") {
    if (
      typeof parsed.sequence !== "number" ||
      !Number.isInteger(parsed.sequence) ||
      parsed.sequence < 1 ||
      typeof parsed.event !== "string"
    ) {
      throw new Error("Control protocol event is malformed.");
    }
    return parsed as unknown as ProtocolEvent;
  }
  if (parsed.kind === "cancel") {
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length < 1 ||
      parsed.id.length > 128
    ) {
      throw new Error("Control protocol cancel message is malformed.");
    }
    return parsed as unknown as ProtocolCancel;
  }
  throw new Error("Unknown control protocol message kind.");
}

export function serializeControlProtocolMessage(
  message: ControlProtocolMessage,
): string {
  const line = JSON.stringify(message);
  if (
    PROTOCOL_TEXT_ENCODER.encode(line).byteLength >
    CONTROL_PROTOCOL_MAX_LINE_BYTES
  ) {
    throw new Error("Control protocol message exceeds the 1 MiB limit.");
  }
  return `${line}\n`;
}
