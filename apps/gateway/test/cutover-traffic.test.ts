import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
} from "@sovereign/runtime-core";
import {
  ToolCatalog,
  createBuiltinTools,
  defineTool,
  objectSchema,
} from "@sovereign/toolkit";
import { WindowsAdapter } from "@sovereign/windows-adapter";

import {
  createGatewayApplication,
  type GatewayApplication,
} from "../src/app.js";

const cleanupPaths: string[] = [];
const token = "runtime-cutover-token";
let gateway: GatewayApplication;
let server: Server;
let baseUrl: string;
let releaseDeferredTool: (() => void) | null = null;
let deferredToolStarted: Promise<void>;

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 2_000,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

async function postMcp(body: unknown, sessionId?: string): Promise<Response> {
  return await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(body),
  });
}

async function openMcpStream(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${baseUrl}/mcp`, {
    method: "GET",
    ...(signal === undefined ? {} : { signal }),
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
}

async function initializeSession(): Promise<string> {
  const response = await postMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "runtime-cutover-test", version: "0.1.0" },
    },
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).not.toBeNull();
  await response.text();
  const initialized = await postMcp(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    sessionId!,
  );
  expect([200, 202, 204]).toContain(initialized.status);
  await initialized.text();
  return sessionId!;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "scr-gateway-cutover-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "workspace"), { recursive: true });

  let markDeferredToolStarted!: () => void;
  deferredToolStarted = new Promise<void>((resolve) => {
    markDeferredToolStarted = resolve;
  });
  const deferredToolRelease = new Promise<void>((resolve) => {
    releaseDeferredTool = resolve;
  });

  const policy = new PolicyEngine();
  const adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root: join(root, "workspace") }],
    policy,
    audit: new MemoryAuditStore(),
  });
  const deferredTool = defineTool(
    {
      name: "system.cutover_test_wait",
      version: "1.0.0",
      title: "Wait for a cutover test gate",
      description:
        "A deterministic test-only read that remains in flight until released.",
      category: "system",
      requiredCapabilities: ["system.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
      inputSchema: objectSchema({}, []),
    },
    {},
    async () => {
      markDeferredToolStarted();
      await deferredToolRelease;
      return { released: true };
    },
  );
  const catalog = new ToolCatalog(
    [...createBuiltinTools(adapter), deferredTool],
    policy,
    "0.1.0",
  );
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      reservation.off("error", reject);
      resolve();
    });
  });
  const reservedAddress = reservation.address();
  if (reservedAddress === null || typeof reservedAddress === "string") {
    throw new Error("Could not reserve a Gateway cutover test port.");
  }
  const port = reservedAddress.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  gateway = createGatewayApplication({
    runtimeVersion: "0.1.0",
    catalog,
    bearerGrants: [
      {
        token,
        principal: {
          id: "runtime-cutover-principal",
          capabilities: new Set(CAPABILITIES),
          workspaceIds: new Set(["workspace"]),
        },
      },
    ],
    allowedHosts: [`127.0.0.1:${port}`],
    allowedOrigins: ["http://127.0.0.1"],
    maxSessions: 4,
    capacityReclaimIdleMs: 60,
    sessionIdleTimeoutMs: 5_000,
    sessionSweepIntervalMs: 100,
  });

  server = createServer(gateway.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  releaseDeferredTool?.();
  releaseDeferredTool = null;
  if (gateway !== undefined) {
    await gateway.close();
  }
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Gateway runtime cutover traffic gate", () => {
  it("quiesces new MCP traffic while allowing an admitted request to drain", async () => {
    const sessionId = await initializeSession();
    const inFlightCall = postMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "system.cutover_test_wait",
          arguments: {},
        },
      },
      sessionId,
    );

    await waitWithTimeout(
      Promise.race([
        deferredToolStarted,
        inFlightCall.then(async (response) => {
          throw new Error(
            `Deferred tool call completed before starting: ${response.status} ${await response.text()}`,
          );
        }),
      ]),
    );
    expect(gateway.activeRequestCount()).toBe(1);

    const quiesced = gateway.quiesce();
    expect(quiesced).toMatchObject({
      schemaVersion: "scr.gateway-traffic/v1",
      generation: 1,
      acceptingRequests: false,
      activeRequestCount: 1,
    });

    const rejected = await postMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      },
      sessionId,
    );
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      error: { code: "RUNTIME_QUIESCED" },
    });
    expect(rejected.headers.get("retry-after")).toBe("1");

    const health = await fetch(`${baseUrl}/healthz`, {
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
      },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      traffic: {
        generation: 1,
        acceptingRequests: false,
        activeRequestCount: 1,
      },
    });

    const timedOut = await gateway.waitForIdle(quiesced.generation, 20);
    expect(timedOut).toMatchObject({
      drained: false,
      timedOut: true,
      interrupted: false,
      activeRequestCount: 1,
    });

    releaseDeferredTool?.();
    const completed = await waitWithTimeout(inFlightCall);
    expect(completed.status).toBe(200);
    const drained = await gateway.waitForIdle(quiesced.generation, 1_000);
    expect(drained).toMatchObject({
      drained: true,
      timedOut: false,
      interrupted: false,
      activeRequestCount: 0,
    });

    const resumed = gateway.resume(quiesced.generation);
    expect(resumed).toMatchObject({
      generation: 2,
      acceptingRequests: true,
      activeRequestCount: 0,
    });
    const acceptedAgain = await postMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      },
      sessionId,
    );
    expect(acceptedAgain.status).toBe(200);
  });

  it("does not let an existing long-lived GET/SSE subscription block a safe drain", async () => {
    const sessionId = await initializeSession();
    const streamAbort = new AbortController();
    const stream = await waitWithTimeout(
      openMcpStream(sessionId, streamAbort.signal),
    );
    expect(stream.status).toBe(200);
    expect(gateway.sessionCount()).toBe(1);
    expect(gateway.activeRequestCount()).toBe(0);

    const quiesced = gateway.quiesce();
    const drained = await gateway.waitForIdle(quiesced.generation, 100);
    expect(drained).toMatchObject({
      drained: true,
      timedOut: false,
      interrupted: false,
      activeRequestCount: 0,
      sessionCount: 1,
    });

    const rejectedStream = await openMcpStream(sessionId);
    expect(rejectedStream.status).toBe(503);
    expect(await rejectedStream.json()).toMatchObject({
      error: { code: "RUNTIME_QUIESCED" },
    });

    streamAbort.abort();
    await stream.body?.cancel().catch(() => undefined);
  });

  it("interrupts a drain wait on resume and rejects stale generations", async () => {
    const sessionId = await initializeSession();
    const inFlightCall = postMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "system.cutover_test_wait",
          arguments: {},
        },
      },
      sessionId,
    );
    await waitWithTimeout(deferredToolStarted);

    const quiesced = gateway.quiesce();
    const waiting = gateway.waitForIdle(quiesced.generation, 5_000);
    const resumed = gateway.resume(quiesced.generation);
    expect(resumed.generation).toBe(2);
    await expect(waiting).resolves.toMatchObject({
      drained: false,
      timedOut: false,
      interrupted: true,
      generation: 2,
    });
    expect(() => gateway.resume(quiesced.generation)).toThrow(
      /generation changed/u,
    );

    releaseDeferredTool?.();
    expect((await waitWithTimeout(inFlightCall)).status).toBe(200);
  });

  it("requires quiescence and bounded arguments before draining", async () => {
    await expect(gateway.waitForIdle(0, 100)).rejects.toThrow(
      /must be quiesced/u,
    );
    const quiesced = gateway.quiesce();
    await expect(gateway.waitForIdle(quiesced.generation, 0)).rejects.toThrow(
      /timeout/u,
    );
    expect(() => gateway.resume(Number.MAX_SAFE_INTEGER)).toThrow(
      /generation changed/u,
    );
  });
});
