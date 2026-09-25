import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTROL_PROTOCOL_VERSION,
  parseControlProtocolMessage,
  serializeControlProtocolMessage,
} from "@sovereign/control-plane-contract";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const scriptPath = resolve(projectRoot, "dist", "bundle", "runtime-host.cjs");
const nativeAgentPath = resolve(
  workspaceRoot,
  "apps",
  "desktop",
  "native",
  "bin",
  "SovereignNativeAgent.exe",
);
const userDataPath = await mkdtemp(resolve(tmpdir(), "sovereign-runtime-host-task-smoke-"));
const authorizedWorkspace = resolve(userDataPath, "workspace");
await mkdir(authorizedWorkspace, { recursive: true });
const session = randomBytes(32).toString("base64url");
const child = spawn(process.execPath, [scriptPath], {
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    SCR_CONTROL_SESSION_SECRET: session,
    SCR_CONTROL_USER_DATA_PATH: userDataPath,
    SCR_CONTROL_NATIVE_AGENT_PATH: nativeAgentPath,
    SCR_CONTROL_PARENT_PID: String(process.pid),
  },
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let buffer = "";
let stderr = "";
let closed = false;
let readySettled = false;
const pending = new Map();
let resolveReady;
let rejectReady;
const ready = new Promise((resolvePromise, rejectPromise) => {
  resolveReady = resolvePromise;
  rejectReady = rejectPromise;
});
let resolveClosed;
const childClosed = new Promise((resolvePromise) => {
  resolveClosed = resolvePromise;
});

function send(message) {
  child.stdin.write(serializeControlProtocolMessage({
    v: CONTROL_PROTOCOL_VERSION,
    session,
    ...message,
  }));
}

function callControl(method, params = {}, timeoutMs = 20_000) {
  const id = `task-smoke-${randomUUID()}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Control request timed out: ${method}. stderr=${stderr}`));
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve(value) {
        clearTimeout(timer);
        resolvePromise(value);
      },
      reject(error) {
        clearTimeout(timer);
        rejectPromise(error);
      },
    });
    send({ kind: "request", id, method, params });
  });
}

function failPending(error) {
  if (!readySettled) {
    readySettled = true;
    rejectReady(error);
  }
  for (const item of pending.values()) item.reject(error);
  pending.clear();
}

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/u, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = parseControlProtocolMessage(line, session);
    } catch (error) {
      failPending(error instanceof Error ? error : new Error(String(error)));
      continue;
    }
    if (message.kind === "request") {
      if (message.method === "workspace.choose") {
        send({
          kind: "response",
          id: message.id,
          ok: true,
          result: authorizedWorkspace,
        });
      } else {
        send({
          kind: "response",
          id: message.id,
          ok: false,
          error: {
            code: "TASK_SMOKE_UNEXPECTED_SHELL_REQUEST",
            message: `Unexpected shell request: ${message.method}`,
          },
        });
      }
      continue;
    }
    if (message.kind === "event" && message.event === "host.ready") {
      if (!readySettled) {
        readySettled = true;
        resolveReady(message.payload);
      }
      continue;
    }
    if (message.kind === "response") {
      const item = pending.get(message.id);
      if (item === undefined) continue;
      pending.delete(message.id);
      if (message.ok) {
        item.resolve(message.result);
      } else {
        item.reject(new Error(
          `${item.method} failed: ${message.error?.code ?? "UNKNOWN"}: ${message.error?.message ?? "unknown error"}`,
        ));
      }
    }
  }
});
child.once("error", (error) => {
  failPending(error);
});
child.once("close", (code, signal) => {
  closed = true;
  const error = code === 0
    ? null
    : new Error(`Runtime host exited with code ${String(code)}, signal ${String(signal)}. stderr=${stderr}`);
  if (error !== null) failPending(error);
  resolveClosed({ code, signal });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function initializeMcp(endpoint, authorization) {
  const headers = {
    Authorization: authorization,
    Origin: new URL(endpoint).origin,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "runtime-host-task-smoke", version: "1.0.0" },
      },
    }),
  });
  assert(response.status === 200, `MCP initialize returned ${response.status}.`);
  const sessionId = response.headers.get("mcp-session-id");
  assert(typeof sessionId === "string" && sessionId.length > 0, "MCP initialize omitted session id.");
  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  assert(
    initialized.status === 200 || initialized.status === 202,
    `MCP initialized notification returned ${initialized.status}.`,
  );
  return { headers, sessionId };
}

async function callTool(endpoint, mcp, id, name, args) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...mcp.headers, "Mcp-Session-Id": mcp.sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert(response.status === 200, `${name} returned HTTP ${response.status}.`);
  const body = await response.json();
  assert(body?.result?.isError !== true, `${name} returned an MCP tool error: ${JSON.stringify(body)}`);
  const text = body?.result?.content?.find((item) => item?.type === "text")?.text;
  assert(typeof text === "string", `${name} omitted text output.`);
  return JSON.parse(text);
}

try {
  const readyPayload = await Promise.race([
    ready,
    new Promise((_, rejectPromise) => setTimeout(
      () => rejectPromise(new Error(`Runtime host did not become ready. stderr=${stderr}`)),
      20_000,
    )),
  ]);
  assert(readyPayload?.state?.phase === "setup-required", "Task smoke expected setup-required initial state.");

  const selected = await callControl("workspace.choose");
  assert(selected?.phase === "running", `Workspace selection did not start the runtime: ${JSON.stringify(selected)}`);
  assert(selected?.workspaceRoot === authorizedWorkspace, "Runtime host selected the wrong workspace.");

  const permission = await callControl("permission.set", { profile: "workspace" });
  assert(permission?.permissionProfile === "workspace", "Runtime host did not apply workspace permission.");

  const connection = await callControl("connection.bundle");
  const bundle = JSON.parse(connection.serialized);
  const endpoint = bundle?.transport?.url;
  const authorization = bundle?.transport?.headers?.Authorization;
  assert(typeof endpoint === "string", "Connection bundle omitted endpoint.");
  assert(typeof authorization === "string", "Connection bundle omitted authorization.");
  const mcp = await initializeMcp(endpoint, authorization);

  const created = await callTool(endpoint, mcp, 2, "tasks.create", {
    projectRoot: authorizedWorkspace,
    projectName: "Runtime Host Task Smoke",
    title: "Exercise task protocol end to end",
    category: "testing",
    status: "running",
    currentStep: "Verify control and MCP bridges",
    progressCurrent: 1,
    progressTotal: 3,
    agentId: "runtime-host-smoke-agent",
    agentName: "Runtime Host Smoke Agent",
    idempotencyKey: "runtime-host-task-smoke",
  });
  assert(created?.title === "Exercise task protocol end to end", "tasks.create returned the wrong task.");

  const listPage = await callTool(endpoint, mcp, 5, "tasks.list", {
    offset: 0,
    limit: 1,
  });
  assert(listPage?.offset === 0, "tasks.list returned the wrong page offset.");
  assert(listPage?.limit === 1, "tasks.list returned the wrong page size.");
  assert(listPage?.totalTaskCount === 1, "tasks.list returned the wrong task total.");
  assert(listPage?.nextOffset === null, "tasks.list returned an unexpected next page.");
  assert(listPage?.projects?.[0]?.tasks?.[0]?.id === created.id, "tasks.list returned the wrong task id.");
  assert(listPage.projects[0].tasks[0].steps === undefined, "tasks.list leaked full task steps.");
  assert(listPage.projects[0].tasks[0].agent?.principalId === undefined, "tasks.list leaked Agent principal identity.");

  const snapshot = await callControl("tasks.snapshot", { offset: 0, limit: 1 });
  assert(snapshot?.offset === 0 && snapshot?.limit === 1, "tasks.snapshot returned the wrong page metadata.");
  assert(snapshot?.totalTaskCount === 1 && snapshot?.nextOffset === null, "tasks.snapshot returned the wrong totals.");
  assert(snapshot?.projects?.length === 1, "tasks.snapshot did not return the created project.");
  assert(snapshot.projects[0]?.tasks?.[0]?.id === created.id, "tasks.snapshot returned the wrong task id.");

  const detail = await callControl("tasks.get", { taskId: created.id, messageLimit: 20 });
  assert(detail?.task?.id === created.id, "tasks.get returned the wrong task.");
  assert(detail?.messages?.[0]?.role === "system", "tasks.get omitted the task creation message.");

  const userMessage = "Continue the task protocol smoke without operator intervention.";
  const afterUserMessage = await callControl("tasks.message.user", {
    taskId: created.id,
    content: userMessage,
  });
  assert(
    afterUserMessage?.messages?.at(-1)?.content === userMessage,
    "tasks.message.user did not persist the local user message.",
  );

  const heartbeat = await callTool(endpoint, mcp, 3, "tasks.heartbeat", {
    taskId: created.id,
    agentId: "runtime-host-smoke-agent",
    agentName: "Runtime Host Smoke Agent",
    status: "running",
    currentStep: "Acknowledge the queued user message",
    progressCurrent: 2,
    progressTotal: 3,
  });
  assert(
    heartbeat?.pendingUserMessages?.some((message) => message.content === userMessage),
    "tasks.heartbeat did not deliver the queued local user message.",
  );

  await callTool(endpoint, mcp, 4, "tasks.message.send", {
    taskId: created.id,
    content: "Task protocol smoke message acknowledged.",
    agentId: "runtime-host-smoke-agent",
    agentName: "Runtime Host Smoke Agent",
  });
  const finalDetail = await callControl("tasks.get", { taskId: created.id, messageLimit: 20 });
  assert(
    finalDetail?.messages?.at(-1)?.content === "Task protocol smoke message acknowledged.",
    "Agent task message did not cross the MCP-to-control bridge.",
  );

  await callControl("shutdown");
  const closedResult = await Promise.race([
    childClosed,
    new Promise((_, rejectPromise) => setTimeout(
      () => rejectPromise(new Error(`Runtime host did not exit after shutdown. stderr=${stderr}`)),
      20_000,
    )),
  ]);
  assert(closedResult.code === 0, `Runtime host shutdown exit code was ${String(closedResult.code)}.`);
  console.log("Runtime host task control/MCP roundtrip smoke passed.");
} finally {
  if (!closed) child.kill();
  await childClosed.catch(() => undefined);
  await rm(userDataPath, {
    recursive: true,
    force: true,
    maxRetries: 24,
    retryDelay: 250,
  });
}
