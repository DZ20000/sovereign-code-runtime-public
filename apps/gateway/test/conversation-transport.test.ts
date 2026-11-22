import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPABILITIES, createPrincipal, PolicyEngine } from "@sovereign/runtime-core";
import { defineTool, ToolCatalog } from "@sovereign/toolkit";
import { createGatewayApplication, type GatewayApplication } from "../src/app.js";

const token = "test-" + "a".repeat(35);
const otherToken = "test-" + "b".repeat(35);
const meta = (id: string) => ({ "openai/session": id, "openai/subject": "synthetic-user" });
let server: Server;
let gateway: GatewayApplication;
let sequence = 0;

beforeEach(async () => {
  const catalog = new ToolCatalog([
    defineTool({
      name: "session.inspect", version: "1.0.0", title: "Inspect test session",
      description: "Return the authenticated test context.", category: "system",
      requiredCapabilities: ["system.read"], sideEffect: "read", destructive: false,
      permissionLevel: "observe", approvalMode: "none",
    }, {}, context => ({ principalId: context.principal.id, sessionId: context.sessionId })),
  ], new PolicyEngine(), "0.1.6");
  gateway = createGatewayApplication({
    runtimeVersion: "0.1.6", catalog, allowedHosts: ["127.0.0.1"], allowedOrigins: [],
    bearerGrants: [
      { token, principal: createPrincipal("test-owner", CAPABILITIES, []) },
      { token: otherToken, principal: createPrincipal("test-other", CAPABILITIES, []) },
    ],
    normalizeToolInput: async request => {
      await new Promise<void>(done => setImmediate(done));
      return request.input;
    },
  });
  server = createServer(gateway.app);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
});

afterEach(async () => {
  await gateway.close();
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

async function rpc(body: unknown, transport?: string, bearer = token, method = "POST") {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  return await new Promise<{ status: number; session: string | undefined; result: Record<string, unknown> }>((done, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/mcp", method,
      headers: {
        Host: "127.0.0.1", Authorization: "Bearer " + bearer,
        Accept: "application/json, text/event-stream", "Content-Type": "application/json",
        ...(transport ? { "Mcp-Session-Id": transport } : {}),
        ...(bytes ? { "Content-Length": String(Buffer.byteLength(bytes)) } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        done({
          status: response.statusCode ?? 0,
          session: response.headers["mcp-session-id"] as string | undefined,
          result: text ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    request.once("error", reject);
    request.end(bytes);
  });
}

async function transport(bearer = token) {
  const response = await rpc({
    jsonrpc: "2.0", id: ++sequence, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "isolated-test", version: "1" } },
  }, undefined, bearer);
  expect(response.status).toBe(200);
  expect(response.session).toBeTypeOf("string");
  return response.session!;
}

async function inspect(transportId: string, metadata: Record<string, unknown>, bearer = token, args = {}) {
  const response = await rpc({
    jsonrpc: "2.0", id: ++sequence, method: "tools/call",
    params: { name: "session.inspect", arguments: args, _meta: metadata },
  }, transportId, bearer);
  const result = response.result.result as { isError?: boolean; structuredContent?: { result?: { sessionId: string; principalId: string } } } | undefined;
  return { status: response.status, isError: result?.isError, value: result?.structuredContent?.result };
}

describe("authenticated conversation context over HTTP", () => {
  it("correlates rotating transports while isolating concurrent calls and principals", async () => {
    const first = await transport();
    const second = await transport();
    const [a, b, same] = await Promise.all([
      inspect(first, meta("A")), inspect(first, meta("B")), inspect(second, meta("A")),
    ]);
    expect(a.value?.sessionId).toMatch(/^conversation-/);
    expect(same.value?.sessionId).toBe(a.value?.sessionId);
    expect(b.value?.sessionId).not.toBe(a.value?.sessionId);
    const foreign = await inspect(await transport(otherToken), meta("A"), otherToken);
    expect(foreign.value?.principalId).toBe("test-other");
    expect(foreign.value?.sessionId).not.toBe(a.value?.sessionId);
  });

  it("requires bearer authentication and rejects identity in model arguments", async () => {
    const current = await transport();
    expect((await inspect(current, meta("A"), "invalid-test-token")).status).toBe(401);
    expect((await inspect(current, meta("A"), token, { _meta: meta("B") })).isError).toBe(true);
    expect((await inspect(current, { "openai/session": "" })).isError).toBe(true);
    const physical = await inspect(current, {});
    expect(physical.value?.sessionId).toBe(current);
  });

  it("creates a new epoch after an explicit client closes a shared context", async () => {
    const first = await transport();
    const second = await transport();
    const before = await inspect(first, meta("A"));
    expect((await inspect(second, meta("A"))).value?.sessionId).toBe(before.value?.sessionId);
    expect((await rpc(undefined, first, token, "DELETE")).status).toBe(200);
    expect((await inspect(second, meta("A"))).value?.sessionId).not.toBe(before.value?.sessionId);
  });
});
