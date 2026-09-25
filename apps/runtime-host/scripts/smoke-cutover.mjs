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
const userDataPath = await mkdtemp(
  resolve(tmpdir(), "sovereign-runtime-host-cutover-smoke-"),
);
const authorizedWorkspace = resolve(userDataPath, "workspace");
await mkdir(authorizedWorkspace, { recursive: true });
const fencingToken = randomBytes(32).toString("base64url");
const gatewayBearerToken = randomBytes(32).toString("base64url");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class RuntimeHostProcess {
  #child;
  #session;
  #buffer = "";
  #stderr = "";
  #pending = new Map();
  #closed = false;
  #readySettled = false;
  #resolveReady;
  #rejectReady;
  #resolveClosed;

  constructor({ instanceId, releaseId, role, promotionToken, gatewayToken }) {
    this.#session = randomBytes(32).toString("base64url");
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady;
      this.#rejectReady = rejectReady;
    });
    this.closed = new Promise((resolveClosed) => {
      this.#resolveClosed = resolveClosed;
    });
    this.#child = spawn(process.execPath, [scriptPath], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SCR_CONTROL_SESSION_SECRET: this.#session,
        SCR_CONTROL_USER_DATA_PATH: userDataPath,
        SCR_CONTROL_NATIVE_AGENT_PATH: nativeAgentPath,
        SCR_CONTROL_PARENT_PID: String(process.pid),
        SCR_WORKSPACE_ROOT: authorizedWorkspace,
        SCR_RUN_COMPLETION_NOTIFICATIONS: "0",
        SCR_RUNTIME_CUTOVER_ROLE: role,
        SCR_RUNTIME_INSTANCE_ID: instanceId,
        SCR_RUNTIME_RELEASE_ID: releaseId,
        SCR_RUNTIME_GATEWAY_BEARER_TOKEN: gatewayToken,
        ...(promotionToken === undefined
          ? {}
          : { SCR_RUNTIME_PROMOTION_FENCING_TOKEN: promotionToken }),
      },
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
    this.#child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("close", (code, signal) => {
      this.#closed = true;
      const error =
        code === 0
          ? null
          : new Error(
              `Runtime Host ${instanceId} exited with code ${String(code)}, ` +
                `signal ${String(signal)}. stderr=${this.#stderr}`,
            );
      if (error !== null) this.#fail(error);
      this.#resolveClosed({ code, signal });
    });
  }

  get stderr() {
    return this.#stderr;
  }

  get isClosed() {
    return this.#closed;
  }

  #send(message) {
    this.#child.stdin.write(
      serializeControlProtocolMessage({
        v: CONTROL_PROTOCOL_VERSION,
        session: this.#session,
        ...message,
      }),
    );
  }

  #onStdout(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = parseControlProtocolMessage(line, this.#session);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message.kind === "request") {
        this.#handleShellRequest(message);
        continue;
      }
      if (message.kind === "event" && message.event === "host.ready") {
        if (this.#readySettled) {
          this.#fail(
            new Error("Runtime Host emitted host.ready more than once."),
          );
        } else {
          this.#readySettled = true;
          this.#resolveReady(message.payload);
        }
        continue;
      }
      if (message.kind !== "response") continue;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const error = new Error(
          `${pending.method} failed: ${message.error?.code ?? "UNKNOWN"}: ` +
            `${message.error?.message ?? "unknown error"}`,
        );
        error.code = message.error?.code;
        pending.reject(error);
      }
    }
  }

  #handleShellRequest(message) {
    let result = null;
    let ok = true;
    if (message.method === "workspace.choose") {
      result = authorizedWorkspace;
    } else if (message.method === "secret.restore") {
      result = null;
    } else {
      ok = false;
    }
    this.#send({
      kind: "response",
      id: message.id,
      ok,
      ...(ok
        ? { result }
        : {
            error: {
              code: "CUTOVER_SMOKE_UNEXPECTED_SHELL_REQUEST",
              message: `Unexpected shell request: ${message.method}`,
            },
          }),
    });
  }

  #fail(error) {
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(error);
    }
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async waitUntilReady(timeoutMs = 30_000) {
    return await withTimeout(
      this.ready,
      timeoutMs,
      () => `Runtime Host readiness timed out. stderr=${this.#stderr}`,
    );
  }

  call(method, params = {}, timeoutMs = 30_000) {
    const id = `cutover-smoke-${randomUUID()}`;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectCall(
          new Error(
            `Runtime Host control request timed out: ${method}. stderr=${this.#stderr}`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve(value) {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectCall(error);
        },
      });
      this.#send({ kind: "request", id, method, params });
    });
  }

  async shutdown() {
    if (this.#closed) return;
    await this.call("shutdown").catch(() => undefined);
    const result = await withTimeout(
      this.closed,
      15_000,
      () => `Runtime Host shutdown timed out. ${this.#stderr}`,
    );
    assert(
      result.code === 0,
      `Runtime Host shutdown exit code was ${String(result.code)}.`,
    );
  }

  kill() {
    if (!this.#closed) this.#child.kill();
  }
}

let active;
let candidate;
try {
  active = new RuntimeHostProcess({
    instanceId: "cutover-active-1",
    releaseId: "release-1",
    role: "active",
    gatewayToken: gatewayBearerToken,
  });
  const activeReady = await active.waitUntilReady();
  assert(
    activeReady?.state?.phase === "running",
    "Active Runtime Host did not start its Gateway.",
  );
  assert(
    activeReady?.cutover?.role === "active",
    "Active Runtime Host reported the wrong cutover role.",
  );
  assert(
    activeReady?.cutover?.promoted === true,
    "Active Runtime Host was not authoritative.",
  );

  const activeConnection = await active.call("connection.bundle");
  const activeAuthorization = JSON.parse(activeConnection.serialized).transport
    .headers.Authorization;
  assert(
    activeAuthorization === `Bearer ${gatewayBearerToken}`,
    "Active Runtime Host did not use the supervisor-supplied Gateway credential.",
  );

  const activeStatus = await active.call("cutover.status");
  assert(
    activeStatus?.controlGeneration === 0,
    "Active control generation did not start at zero.",
  );
  const quiesced = await active.call("cutover.quiesce");
  assert(
    quiesced?.controlQuiesced === true,
    "Active Runtime Host did not quiesce.",
  );
  assert(
    quiesced?.gateway?.acceptingRequests === false,
    "Active Gateway continued accepting requests after quiesce.",
  );
  await assertRejectCode(
    active.call("state.get"),
    "POLICY_DENIED",
    "Quiesced Runtime Host accepted an ordinary control request.",
  );
  const drained = await active.call("cutover.drain", {
    controlGeneration: quiesced.controlGeneration,
    gatewayGeneration: quiesced.gateway?.generation ?? null,
    timeoutMs: 10_000,
  });
  assert(
    drained?.drained === true,
    `Active Runtime Host did not drain: ${JSON.stringify(drained)}`,
  );
  const checkpoint = await active.call("cutover.checkpoint", {
    controlGeneration: quiesced.controlGeneration,
    gatewayGeneration: quiesced.gateway?.generation ?? null,
    fencingToken,
  });
  assert(
    typeof checkpoint?.checkpointId === "string" &&
      checkpoint.checkpointId.length > 0,
    "Active Runtime Host did not produce a checkpoint id.",
  );
  assert(
    /^[a-f0-9]{64}$/u.test(checkpoint?.stateSha256 ?? ""),
    "Active Runtime Host checkpoint omitted a state digest.",
  );

  const detached = await active.call("cutover.detach", {
    controlGeneration: quiesced.controlGeneration,
    gatewayGeneration: quiesced.gateway?.generation ?? null,
    checkpointId: checkpoint.checkpointId,
    fencingToken,
  });
  assert(
    detached?.trafficDetached === true,
    "Active Runtime Host did not detach external traffic after checkpointing.",
  );
  assert(
    detached?.externalRouteDesired === checkpoint.externalRouteDesired,
    "Detached route intent diverged from the checkpoint.",
  );

  candidate = new RuntimeHostProcess({
    instanceId: "cutover-candidate-2",
    releaseId: "release-2",
    role: "candidate",
    promotionToken: fencingToken,
    gatewayToken: gatewayBearerToken,
  });
  const candidateReady = await candidate.waitUntilReady();
  assert(
    candidateReady?.state?.phase === "running",
    `Passive candidate did not start a private Gateway: ${JSON.stringify(candidateReady)}`,
  );
  assert(
    candidateReady?.cutover?.role === "candidate",
    "Candidate reported the wrong role.",
  );
  assert(
    candidateReady?.cutover?.promoted === false,
    "Candidate became authoritative before promotion.",
  );
  await candidate.call("state.get");
  await assertRejectCode(
    candidate.call("runtime.stop"),
    "POLICY_DENIED",
    "Passive candidate accepted a mutation before promotion.",
  );
  await assertRejectCode(
    candidate.call("cutover.canary"),
    "POLICY_DENIED",
    "Passive candidate accepted a canary before promotion.",
  );
  await assertRejectCode(
    candidate.call("cutover.promote", {
      checkpointId: checkpoint.checkpointId,
      fencingToken: randomBytes(32).toString("base64url"),
      externalRouteDesired: checkpoint.externalRouteDesired,
    }),
    "AUTH_INVALID",
    "Candidate accepted an invalid promotion fencing token.",
  );
  const promoted = await candidate.call("cutover.promote", {
    checkpointId: checkpoint.checkpointId,
    fencingToken,
    externalRouteDesired: checkpoint.externalRouteDesired,
  });
  assert(
    promoted?.role === "active" && promoted?.promoted === true,
    "Candidate promotion failed.",
  );
  const candidateConnection = await candidate.call("connection.bundle");
  const candidateAuthorization = JSON.parse(candidateConnection.serialized)
    .transport.headers.Authorization;
  assert(
    candidateAuthorization === activeAuthorization,
    "Promoted candidate changed the MCP Gateway bearer credential.",
  );

  const canary = await candidate.call("cutover.canary");
  assert(
    canary?.promoted === true,
    "Promoted candidate canary was not authoritative.",
  );
  assert(
    /^[a-f0-9]{64}$/u.test(canary?.stateSha256 ?? ""),
    "Candidate canary omitted a digest.",
  );

  await active.shutdown();
  await candidate.shutdown();
  console.log(
    JSON.stringify(
      {
        schemaVersion: "scr.runtime-host-cutover-smoke/v1",
        passed: true,
        checkpointId: checkpoint.checkpointId,
        candidateStateSha256: canary.stateSha256,
        gatewayCredentialPreserved:
          candidateAuthorization === activeAuthorization,
      },
      null,
      2,
    ),
  );
} finally {
  active?.kill();
  candidate?.kill();
  await Promise.all([
    active?.closed.catch(() => undefined),
    candidate?.closed.catch(() => undefined),
  ]);
  await rm(userDataPath, {
    recursive: true,
    force: true,
    maxRetries: 24,
    retryDelay: 250,
  });
}

async function assertRejectCode(promise, code, message) {
  try {
    await promise;
  } catch (error) {
    if (error?.code === code || String(error?.message).includes(`: ${code}:`))
      return;
    throw new Error(`${message} Received ${String(error?.message ?? error)}`);
  }
  throw new Error(message);
}
