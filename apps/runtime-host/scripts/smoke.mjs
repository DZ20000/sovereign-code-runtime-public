import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
const session = randomBytes(32).toString("base64url");
const userDataPath = await mkdtemp(resolve(tmpdir(), "sovereign-runtime-host-smoke-"));
const scriptPath = resolve(projectRoot, "dist", "bundle", "runtime-host.cjs");
const nativeAgentPath = resolve(workspaceRoot, "apps", "desktop", "native", "bin", "SovereignNativeAgent.exe");
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
let ready = false;
let stateResponse = false;
let shutdownResponse = false;
let stateRequestId = "";
let shutdownRequestId = "";
let settled = false;

function writeRequest(method, params = {}) {
  const id = `smoke-${randomUUID()}`;
  child.stdin.write(serializeControlProtocolMessage({
    v: CONTROL_PROTOCOL_VERSION,
    session,
    kind: "request",
    id,
    method,
    params,
  }));
  return id;
}

const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectOutcome(error);
    else resolveOutcome();
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error(`Runtime host smoke timed out. stderr=${stderr}`));
  }, 20_000);

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
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.kind === "request") {
        child.stdin.write(serializeControlProtocolMessage({
          v: CONTROL_PROTOCOL_VERSION,
          session,
          kind: "response",
          id: message.id,
          ok: false,
          error: { code: "SMOKE_NO_SHELL", message: `Unexpected shell request: ${message.method}` },
        }));
        continue;
      }
      if (message.kind === "event" && message.event === "host.ready") {
        if (ready) {
          finish(new Error("Runtime host emitted host.ready more than once."));
          return;
        }
        if (message.payload?.processId !== child.pid || message.payload?.state?.phase !== "setup-required") {
          finish(new Error(`Invalid host.ready payload: ${JSON.stringify(message.payload)}`));
          return;
        }
        ready = true;
        stateRequestId = writeRequest("state.get");
        continue;
      }
      if (message.kind === "response" && message.id === stateRequestId) {
        if (!message.ok || message.result?.phase !== "setup-required") {
          finish(new Error(`Invalid state.get response: ${JSON.stringify(message)}`));
          return;
        }
        stateResponse = true;
        shutdownRequestId = writeRequest("shutdown");
        continue;
      }
      if (message.kind === "response" && message.id === shutdownRequestId) {
        if (!message.ok) {
          finish(new Error(`Runtime host shutdown failed: ${JSON.stringify(message)}`));
          return;
        }
        shutdownResponse = true;
      }
    }
  });
  child.once("error", finish);
  child.once("close", (code, signal) => {
    if (!ready || !stateResponse || !shutdownResponse || code !== 0) {
      finish(new Error(
        `Runtime host smoke failed: ready=${ready} state=${stateResponse} shutdown=${shutdownResponse} code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
      ));
      return;
    }
    finish(null);
  });
});

void outcome;
await rm(userDataPath, { recursive: true, force: true, maxRetries: 24, retryDelay: 250 });
console.log("Runtime host stdio smoke passed.");
