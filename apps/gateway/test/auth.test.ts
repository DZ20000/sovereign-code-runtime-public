import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import { ToolCatalog, createBuiltinTools } from "@sovereign/toolkit";
import { WindowsAdapter } from "@sovereign/windows-adapter";
import {
  createGatewayApplication,
  type GatewayApplication,
  type GatewaySessionActivityEvent,
  type GatewaySessionClosedEvent,
  type GatewayToolInputNormalizationRequest,
} from "../src/app.js";

interface TestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface RequestOptions {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

function sendRequest(
  server: Server,
  options: RequestOptions,
): Promise<TestResponse> {
  const address = server.address() as AddressInfo;
  const body = options.body ?? "";
  const headers: Record<string, string> = {
    Host: "127.0.0.1",
    ...(options.headers ?? {}),
  };
  if (body.length > 0) {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  return new Promise<TestResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    if (body.length > 0) {
      request.write(body);
    }
    request.end();
  });
}

let root: string;
let gateway: GatewayApplication;
let server: Server;
let adapter: WindowsAdapter;
let catalog: ToolCatalog;
let sessionActivityEvents: GatewaySessionActivityEvent[];
let sessionClosedEvents: GatewaySessionClosedEvent[];
let toolInputNormalizations: GatewayToolInputNormalizationRequest[];
const token = "test-token-0123456789abcdef";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scr-gateway-"));
  await writeFile(
    join(root, "canonical.txt"),
    "canonical project input\n",
    "utf8",
  );
  const policy = new PolicyEngine();
  const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);
  adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy,
    audit: new MemoryAuditStore(),
  });
  catalog = new ToolCatalog(createBuiltinTools(adapter), policy, "0.1.0");
  sessionActivityEvents = [];
  sessionClosedEvents = [];
  toolInputNormalizations = [];
  gateway = createGatewayApplication({
    runtimeVersion: "0.1.0",
    catalog,
    bearerGrants: [{ token, principal }],
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["http://127.0.0.1"],
    maxSessions: 1,
    capacityReclaimIdleMs: 60,
    sessionIdleTimeoutMs: 100,
    sessionSweepIntervalMs: 20,
    onSessionActivity: (event) => sessionActivityEvents.push(event),
    onSessionClosed: (event) => sessionClosedEvents.push(event),
    normalizeToolInput: (request) => {
      toolInputNormalizations.push(request);
      return request.toolName === "files.read" && request.input.path === "."
        ? { ...request.input, path: "canonical.txt" }
        : request.input;
    },
  });
  server = createServer(gateway.app);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
});

afterEach(async () => {
  await gateway.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
});

async function callGatewayTool(name: string, input: Record<string, unknown>) {
  const headers = {
    Authorization: `Bearer ${token}`, Origin: "http://127.0.0.1",
    Accept: "application/json, text/event-stream", "Content-Type": "application/json",
  };
  const initialized = await sendRequest(server, {
    method: "POST", path: "/mcp", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "image-result-test", version: "1.0.0" },
    } }),
  });
  const session = initialized.headers["mcp-session-id"];
  const response = await sendRequest(server, {
    method: "POST", path: "/mcp",
    headers: { ...headers, "Mcp-Session-Id": String(Array.isArray(session) ? session[0] : session) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: input } }),
  });
  expect(response.status).toBe(200);
  return CallToolResultSchema.parse(JSON.parse(response.body).result);
}

// A one-pixel JPEG keeps the transport fixture independent of native capture.
const screenshotBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

describe("Gateway screenshot content", () => {
  it.each([
    ["browser.observe", true], ["computer.observe", true],
    ["browser.observe", false], ["computer.observe", false],
  ] as const)("presents %s with includeScreenshot=%s", async (name, includeScreenshot) => {
    const metadata = name === "browser.observe"
      ? { id: "browser-fixture", state: "ready" as const, createdAt: "2026-09-09T00:00:00Z",
          processId: null, url: "https://example.test/", title: "Image fixture", allowedDomains: ["example.test"],
          blockedRequestCount: 0, error: null, revision: "browser-revision", text: "Image preview",
          accessibility: [], elements: [] }
      : { revision: "computer-revision", capturedAt: "2026-09-09T00:00:00Z",
          virtualScreen: { x: 0, y: 0, width: 1, height: 1 }, windows: [],
          screenshotSha256: "fixture-digest", screenshotBytes: Buffer.byteLength(screenshotBase64, "base64") };
    const screenshot = includeScreenshot ? { screenshotBase64, screenshotMediaType: "image/jpeg" as const } : {};
    const observation = { ...metadata, ...screenshot };
    const method = name === "browser.observe" ? "observeBrowser" : "observeComputer";
    vi.spyOn(adapter, method).mockResolvedValue(observation);
    const result = await callGatewayTool(name, {
      workspaceId: "workspace", includeScreenshot,
      ...(name === "browser.observe" ? { sessionId: "browser-fixture" } : {}),
    });
    const publicMetadata = { ...metadata, ...(includeScreenshot ? { screenshotMediaType: "image/jpeg" } : {}) };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(publicMetadata, null, 2) });
    expect(result.structuredContent).toEqual({ schemaVersion: "scr.mcp-tool-result/v2", result: publicMetadata });
    expect(result.content.filter((item) => item.type === "image")).toEqual(includeScreenshot
      ? [{ type: "image", mimeType: "image/jpeg", data: screenshotBase64 }] : []);
    expect(JSON.stringify(result.structuredContent)).not.toContain(screenshotBase64);
    expect(observation).toEqual({ ...metadata, ...screenshot });
  });

  it("preserves similarly named fields from other tools", async () => {
    const observation = { screenshotBase64, screenshotMediaType: "image/jpeg", value: 42n };
    vi.spyOn(catalog, "invoke").mockResolvedValueOnce(observation);
    const result = await callGatewayTool("system.info", {});
    const expected = { ...observation, value: "42" };
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected, null, 2) }]);
    expect(result.structuredContent).toEqual({ schemaVersion: "scr.mcp-tool-result/v2", result: expected });
  });

  it.each(["invalid", "empty", "oversized", "wrong-media"])("rejects %s screenshots without returning pixel text", async (invalid) => {
    const payload = invalid === "oversized" ? Buffer.alloc(8_000_001).toString("base64")
      : invalid === "empty" ? "" : invalid === "invalid" ? "not-base64!" : screenshotBase64;
    vi.spyOn(catalog, "invoke").mockResolvedValueOnce({
      revision: "fixture", screenshotBase64: payload,
      screenshotMediaType: invalid === "wrong-media" ? "image/png" : "image/jpeg",
    });
    const result = await callGatewayTool("computer.observe", { workspaceId: "workspace", includeScreenshot: true });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.structuredContent).toMatchObject({
      schemaVersion: "scr.mcp-tool-result/v2", result: { error: { code: "INTERNAL_ERROR" } },
    });
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
  });
});

describe("gateway request guards", () => {
  it("requires a valid bearer token", async () => {
    const missing = await sendRequest(server, {
      method: "GET",
      path: "/v1/manifest",
    });
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");

    const valid = await sendRequest(server, {
      method: "GET",
      path: "/v1/manifest",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(valid.status).toBe(200);
    expect(JSON.parse(valid.body)).toEqual(
      expect.objectContaining({ schemaVersion: "scr.tools/v1" }),
    );
  });

  it("rejects non-allowlisted Host and Origin headers", async () => {
    const badHost = await sendRequest(server, {
      method: "GET",
      path: "/v1/manifest",
      headers: {
        Host: "evil.example",
        Authorization: `Bearer ${token}`,
      },
    });
    expect(badHost.status).toBe(403);

    const badOrigin = await sendRequest(server, {
      method: "GET",
      path: "/v1/manifest",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.example",
      },
    });
    expect(badOrigin.status).toBe(403);
  });

  it("accepts an authenticated MCP Streamable HTTP initialize request", async () => {
    const response = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
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
          clientInfo: {
            name: "gateway-test",
            version: "1.0.0",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const sessionHeader = response.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    expect(sessionId).toBeDefined();
    const initializeBody = JSON.parse(response.body) as {
      readonly result?: { readonly instructions?: string };
    };
    expect(initializeBody).toEqual(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
      }),
    );
    expect(initializeBody.result?.instructions).toContain("CHAT_SOVEREIGN");
    expect(initializeBody.result?.instructions).toContain("@Sovereign");
    expect(initializeBody.result?.instructions).toContain("Do not ask the user to switch workspace");
    expect(initializeBody.result?.instructions).toContain("Do not suggest, require, or redirect the user to Work mode");
    const initializedEvent = sessionActivityEvents.find(
      (event) => event.sessionId === sessionId,
    );
    expect(initializedEvent).toMatchObject({
      principalId: "owner",
      sessionId,
    });
    expect(
      Number.isFinite(Date.parse(initializedEvent?.observedAt ?? "")),
    ).toBe(true);

    const tools = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId ?? "missing",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(tools.status).toBe(200);
    expect(
      sessionActivityEvents.filter((event) => event.sessionId === sessionId),
    ).toHaveLength(2);
  });

  it("normalizes tool input with the authenticated MCP session before invocation", async () => {
    const initialize = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
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
          clientInfo: { name: "gateway-normalizer-test", version: "1.0.0" },
        },
      }),
    });
    const sessionHeader = initialize.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    expect(sessionId).toEqual(expect.any(String));

    const call = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId ?? "missing",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "files.read",
          arguments: { workspaceId: "workspace", path: "." },
        },
      }),
    });
    expect(call.status).toBe(200);
    expect(JSON.stringify(JSON.parse(call.body))).toContain(
      "canonical project input",
    );
    expect(toolInputNormalizations).toContainEqual(
      expect.objectContaining({
        principal: expect.objectContaining({ id: "owner" }),
        sessionId,
        toolName: "files.read",
        input: { workspaceId: "workspace", path: "." },
      }),
    );
  });

  it("caps concurrent MCP sessions", async () => {
    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gateway-cap-test", version: "1.0.0" },
      },
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "http://127.0.0.1",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    const first = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers,
      body: initializeBody,
    });
    expect(first.status).toBe(200);

    const second = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers,
      body: initializeBody,
    });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBe("1");
    expect(JSON.parse(second.body)).toMatchObject({
      error: {
        code: "POLICY_DENIED",
        details: { maxSessions: 1, retryAfterSeconds: 1 },
      },
    });
  });

  it("reclaims an idle MCP session before rejecting a new initialization at capacity", async () => {
    // Advance the policy clock, not wall time: slow CI must not turn capacity
    // reclamation into the separate idle-expiry path. HTTP remains real.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gateway-reclaim-test", version: "1.0.0" },
      },
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "http://127.0.0.1",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    const first = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers,
      body: initializeBody,
    });
    expect(first.status).toBe(200);
    const firstSessionHeader = first.headers["mcp-session-id"];
    const firstSessionId = Array.isArray(firstSessionHeader)
      ? firstSessionHeader[0]
      : firstSessionHeader;
    expect(firstSessionId).toBeDefined();

    clock.mockReturnValue(now + 75);

    const second = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers,
      body: initializeBody,
    });
    expect(second.status).toBe(200);
    expect(gateway.sessionCount()).toBe(1);
    const reclaimEvent = sessionClosedEvents.find(
      (event) => event.sessionId === firstSessionId,
    );
    expect(reclaimEvent).toMatchObject({
      principalId: "owner",
      sessionId: firstSessionId,
      reason: "capacity-reclaimed",
    });
    expect(Number.isFinite(Date.parse(reclaimEvent?.observedAt ?? ""))).toBe(
      true,
    );

    const reclaimed = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        ...headers,
        "Mcp-Session-Id": firstSessionId ?? "missing",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(reclaimed.status).toBe(404);
  });

  it("reports an explicit MCP session deletion with the exact session identity", async () => {
    const initialize = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
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
          clientInfo: { name: "gateway-delete-test", version: "1.0.0" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    const sessionHeader = initialize.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    expect(sessionId).toBeDefined();

    const deleted = await sendRequest(server, {
      method: "DELETE",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId ?? "missing",
      },
    });
    expect(deleted.status).toBe(200);
    expect(gateway.sessionCount()).toBe(0);
    const closeEvent = sessionClosedEvents.find(
      (event) => event.sessionId === sessionId,
    );
    expect(closeEvent).toMatchObject({
      principalId: "owner",
      sessionId,
      reason: "client-delete",
    });
    expect(Number.isFinite(Date.parse(closeEvent?.observedAt ?? ""))).toBe(
      true,
    );
  });

  it("sweeps abandoned MCP sessions after the idle timeout", async () => {
    const initialize = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
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
          clientInfo: { name: "gateway-idle-test", version: "1.0.0" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    const sessionHeader = initialize.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    expect(sessionId).toBeDefined();

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 240));

    const expired = await sendRequest(server, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "http://127.0.0.1",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId ?? "missing",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(expired.status).toBe(404);
    expect(JSON.parse(expired.body)).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    const timeoutEvent = sessionClosedEvents.find(
      (event) => event.sessionId === sessionId,
    );
    expect(timeoutEvent).toMatchObject({
      principalId: "owner",
      sessionId,
      reason: "idle-timeout",
    });
    expect(Number.isFinite(Date.parse(timeoutEvent?.observedAt ?? ""))).toBe(
      true,
    );
  });
});
