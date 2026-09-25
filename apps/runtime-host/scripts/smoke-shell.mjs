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
const nativeAgentPath = resolve(workspaceRoot, "apps", "desktop", "native", "bin", "SovereignNativeAgent.exe");
const userDataPath = await mkdtemp(resolve(tmpdir(), "sovereign-runtime-host-shell-smoke-"));
const authorizedWorkspace = resolve(userDataPath, "workspace");
await mkdir(authorizedWorkspace, { recursive: true });
const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const runtimeKey = "runtime-host-smoke-key-123456789";
const protectedKey = "protected-runtime-host-smoke-key";

function spawnHost() {
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
  return { child, session };
}

function send(child, session, message) {
  child.stdin.write(serializeControlProtocolMessage({
    v: CONTROL_PROTOCOL_VERSION,
    session,
    ...message,
  }));
}

async function firstLaunch() {
  const { child, session } = spawnHost();
  let buffer = "";
  let stderr = "";
  let configureId = "";
  let permissionId = "";
  let workspaceId = "";
  let shutdownId = "";
  let secretProtectSeen = false;
  let promptSeen = false;
  let workspaceRequestSeen = false;
  let settled = false;

  await new Promise((resolveLaunch, rejectLaunch) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (!child.killed) child.kill();
        rejectLaunch(error);
      } else {
        resolveLaunch();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Runtime host shell smoke timed out. stderr=${stderr}`));
    }, 25_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
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
          if (message.method === "secret.protect") {
            if (message.params?.value !== runtimeKey) {
              finish(new Error("Runtime host sent the wrong secret to secret.protect."));
              return;
            }
            secretProtectSeen = true;
            send(child, session, { kind: "response", id: message.id, ok: true, result: protectedKey });
            continue;
          }
          if (message.method === "prompt") {
            promptSeen = true;
            send(child, session, { kind: "response", id: message.id, ok: true, result: 1 });
            continue;
          }
          if (message.method === "workspace.choose") {
            workspaceRequestSeen = true;
            send(child, session, {
              kind: "response",
              id: message.id,
              ok: true,
              result: authorizedWorkspace,
            });
            continue;
          }
          finish(new Error(`Unexpected shell request: ${message.method}`));
          return;
        }
        if (message.kind === "event" && message.event === "host.ready") {
          workspaceId = `smoke-${randomUUID()}`;
          send(child, session, {
            kind: "request",
            id: workspaceId,
            method: "workspace.choose",
            params: {},
          });
          continue;
        }
        if (message.kind === "response" && message.id === workspaceId) {
          if (
            !message.ok ||
            !workspaceRequestSeen ||
            message.result?.phase !== "running" ||
            message.result?.workspaceRoot !== authorizedWorkspace
          ) {
            finish(new Error(`Workspace-picker roundtrip failed: ${JSON.stringify(message)}`));
            return;
          }
          configureId = `smoke-${randomUUID()}`;
          send(child, session, {
            kind: "request",
            id: configureId,
            method: "tunnel.configure",
            params: { tunnelId, runtimeApiKey: runtimeKey },
          });
          continue;
        }
        if (message.kind === "response" && message.id === configureId) {
          if (!message.ok || !secretProtectSeen || message.result?.secureTunnel?.hasRuntimeApiKey !== true) {
            finish(new Error(`Tunnel configure roundtrip failed: ${JSON.stringify(message)}`));
            return;
          }
          permissionId = `smoke-${randomUUID()}`;
          send(child, session, {
            kind: "request",
            id: permissionId,
            method: "permission.set",
            params: { profile: "bypass" },
          });
          continue;
        }
        if (message.kind === "response" && message.id === permissionId) {
          if (!message.ok || !promptSeen || message.result?.permissionProfile !== "observe") {
            finish(new Error(`Prompt roundtrip failed: ${JSON.stringify(message)}`));
            return;
          }
          shutdownId = `smoke-${randomUUID()}`;
          send(child, session, { kind: "request", id: shutdownId, method: "shutdown", params: {} });
          continue;
        }
        if (message.kind === "response" && message.id === shutdownId && !message.ok) {
          finish(new Error(`Runtime host shutdown response failed: ${JSON.stringify(message)}`));
          return;
        }
      }
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (!secretProtectSeen || !promptSeen || !workspaceRequestSeen || code !== 0) {
        finish(new Error(
          `Runtime host first shell smoke failed: protect=${secretProtectSeen} prompt=${promptSeen} workspace=${workspaceRequestSeen} code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        ));
        return;
      }
      finish(null);
    });
  });
}

async function secondLaunchAndPipeLoss() {
  const { child, session } = spawnHost();
  let buffer = "";
  let stderr = "";
  let restoreSeen = false;
  let readySeen = false;
  let settled = false;

  await new Promise((resolveLaunch, rejectLaunch) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (!child.killed) child.kill();
        rejectLaunch(error);
      } else {
        resolveLaunch();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Runtime host parent-loss smoke timed out. stderr=${stderr}`));
    }, 20_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
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
          if (message.method !== "secret.restore" || message.params?.encoded !== protectedKey) {
            finish(new Error(`Unexpected second-launch shell request: ${JSON.stringify(message)}`));
            return;
          }
          restoreSeen = true;
          send(child, session, {
            kind: "response",
            id: message.id,
            ok: true,
            result: { value: runtimeKey, encoded: protectedKey },
          });
          continue;
        }
        if (message.kind === "event" && message.event === "host.ready") {
          if (!restoreSeen || message.payload?.state?.secureTunnel?.hasRuntimeApiKey !== true) {
            finish(new Error(`Secret restore did not complete before host.ready: ${JSON.stringify(message.payload)}`));
            return;
          }
          readySeen = true;
          child.stdin.end();
        }
      }
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (!restoreSeen || !readySeen || code !== 0) {
        finish(new Error(
          `Runtime host parent-loss smoke failed: restore=${restoreSeen} ready=${readySeen} code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        ));
        return;
      }
      finish(null);
    });
  });
}

try {
  await firstLaunch();
  await secondLaunchAndPipeLoss();
  console.log("Runtime host shell roundtrip and parent-loss smoke passed.");
} finally {
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 24, retryDelay: 250 });
}
