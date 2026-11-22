import { createServer, type RequestListener, type Server } from "node:http";
import { expect, it, vi } from "vitest";
import { createGeminiGatewayBridge } from "../src/gemini-gateway-bridge.js";

it("preserves canonical tool contracts and binds Gemini sessions without accepting host identity metadata", async () => {
  const servers: Server[] = [];
  const listen = async (app: RequestListener) => {
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback listener");
    return "http://127.0.0.1:" + address.port;
  };
  const nativeSession = "ba471584-d460-45b2-9d52-2cf6467bb213";
  const authorization = "Bearer local-fixture-token-123456";
  const definition = {
    name: "files.read_image", description: "Canonical image definition",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { path: { type: "string", maxLength: 4096 } }, required: ["path"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const calls = vi.fn();
  const publicEndpoint = "https://mcp.example.test/mcp";
  try {
    const upstream = await listen(async (req, res) => {
      if (req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/manifest") { res.end(JSON.stringify({ tools: [definition] })); return; }
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(chunk);
      const message = JSON.parse(Buffer.concat(parts).toString());
      if (message.method === "initialize") {
        res.setHeader("Mcp-Session-Id", nativeSession);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25" } }));
        return;
      }
      if (req.headers["mcp-session-id"] !== nativeSession) { res.writeHead(404).end(); return; }
      if (message.method === "tools/list") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: { tools: [{ ...definition, outputSchema: { type: "object" } }] } }));
        return;
      }
      calls(message.params);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { content: [{ type: "text", text: "metadata" }], structuredContent: { result: {} } } }));
    });
    const issuer = "https://login.example.test";
    const app = await createGeminiGatewayBridge({
      publicEndpoint, authorizationServer: { issuer, authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token", response_types_supported: ["code"] },
      verifyToken: { verifyAccessToken: async (token) => ({ token,
        clientId: token === "other-client-token" ? "other" : "gemini",
        scopes: ["sovereign.mcp"], expiresAt: Date.now() / 1000 + 60, resource: new URL(token === "wrong-resource-token" ? "https://other.example.test/mcp" : publicEndpoint) }) },
      localConnection: { schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
        transport: { type: "streamable-http", url: upstream + "/mcp", headers: { Authorization: authorization } } },
    });
    const endpoint = await listen(app) + "/mcp";
    const post = (method: string, params: object, session?: string, token = "gemini-fixture-token") => fetch(endpoint, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json",
        ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const initialized = await post("initialize", {});
    const session = initialized.headers.get("mcp-session-id") ?? "";
    await initialized.arrayBuffer();
    expect(session).toMatch(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/u);
    expect((await post("tools/list", {}, nativeSession)).status).toBe(404);
    expect((await post("tools/list", {}, session, "other-client-token")).status).toBe(404);
    expect((await post("tools/list", {}, session, "wrong-resource-token")).status).toBe(401);
    const list = await (await post("tools/list", {}, session)).json();
    expect(list.result.tools).toEqual([{ ...definition, name: "files_read_image" }]);
    const reply = await (await post("tools/call", { name: "files_read_image",
      arguments: { path: "sample.png" }, _meta: { "openai/session": "spoofed" } }, session)).json();
    expect(reply.result).toEqual({ content: [{ type: "text", text: "metadata" }] });
    expect(calls).toHaveBeenCalledExactlyOnceWith({ name: "files.read_image", arguments: { path: "sample.png" } });
    const rejected = await (await post("tools/call", { name: "unknown_tool", arguments: {} }, session)).json();
    expect(rejected.error.code).toBe(-32602);
    expect(calls).toHaveBeenCalledTimes(1);
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  }
});
