import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startGatewayRuntime } from "../src/runtime.js";

async function stopWithin(stop: Promise<void>, timeoutMs = 2_000): Promise<void> {
  await Promise.race([
    stop,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Gateway shutdown timed out.")), timeoutMs);
    }),
  ]);
}

describe("Gateway shutdown", () => {
  it("closes an authenticated SSE stream without waiting for the client", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "scr-stop-sse-"));
    const token = randomBytes(32).toString("base64url");
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(workspaceRoot, "audit.sqlite"),
      runPath: join(workspaceRoot, "runs.sqlite"),
      runCompletionNotificationsEnabled: false,
    });
    const common = {
      Authorization: `Bearer ${token}`,
      Origin: `http://127.0.0.1:${runtime.port}`,
    };
    const abort = new AbortController();
    let stop: Promise<void> | undefined;
    try {
      const init = await fetch(runtime.endpoint, {
        method: "POST",
        headers: {
          ...common,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "shutdown-test", version: "1" },
          },
        }),
      });
      const sessionId = init.headers.get("mcp-session-id");
      expect(init.status).toBe(200);
      expect(sessionId).toBeTruthy();
      await init.text();
      const initialized = await fetch(runtime.endpoint, {
        method: "POST",
        headers: {
          ...common,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      expect([200, 202, 204]).toContain(initialized.status);
      await initialized.text();
      const stream = await fetch(runtime.endpoint, {
        method: "GET",
        signal: abort.signal,
        headers: {
          ...common,
          Accept: "text/event-stream",
          "Mcp-Session-Id": sessionId!,
        },
      });
      expect(stream.status).toBe(200);
      stop = runtime.stop();
      await stopWithin(stop);
    } finally {
      abort.abort();
      await (stop ?? runtime.stop()).catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("closes an incomplete unauthenticated request body", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "scr-stop-body-"));
    const runtime = await startGatewayRuntime({
      bearerToken: randomBytes(32).toString("base64url"),
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(workspaceRoot, "audit.sqlite"),
      runPath: join(workspaceRoot, "runs.sqlite"),
      runCompletionNotificationsEnabled: false,
    });
    const socket = connect(runtime.port, "127.0.0.1");
    let stop: Promise<void> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop = runtime.stop();
      await stopWithin(stop);
    } finally {
      socket.destroy();
      await (stop ?? runtime.stop()).catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
