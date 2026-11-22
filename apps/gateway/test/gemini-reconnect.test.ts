import { createServer, type RequestListener, type Server } from "node:http";
import { expect, it } from "vitest";
import { createGeminiGatewayBridge } from "../src/gemini-gateway-bridge.js";

it("keeps the Gemini session across a local Gateway change and never replays an uncertain write", async () => {
  const servers: Server[] = [];
  const listen = async (handler: RequestListener) => {
    const server = createServer(handler); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  let oldAvailable = true;
  let calls = 0;
  let unknown = false;
  const oldId = "10000000-0000-4000-8000-000000000001";
  const newId = "10000000-0000-4000-8000-000000000002";
  const gateway = (id: string, bearer: string): RequestListener => async (req, res) => {
    if ((!oldAvailable && id === oldId) || req.headers.authorization !== bearer) { res.writeHead(401).end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/manifest") { res.end(JSON.stringify({ tools: [{ name: "files.write" }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "initialize") {
      res.setHeader("Mcp-Session-Id", id);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25" } })); return;
    }
    if (req.headers["mcp-session-id"] !== id) { res.writeHead(404).end(); return; }
    if (message.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    calls++;
    if (unknown) { req.socket.destroy(); return; }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "written once" }] } }));
  };
  try {
    const first = await listen(gateway(oldId, "Bearer old-local-fixture-key-12345"));
    const second = await listen(gateway(newId, "Bearer new-local-fixture-key-12345"));
    const connection = (url: string, key: string) => ({ schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
      transport: { type: "streamable-http", url: url + "/mcp", headers: { Authorization: "Bearer " + key } } });
    const endpoint = "https://gemini.example.test/mcp";
    const app = await createGeminiGatewayBridge({ publicEndpoint: endpoint,
      authorizationServer: { issuer: "https://login.example.test", authorization_endpoint: "https://login.example.test/authorize",
        token_endpoint: "https://login.example.test/token", response_types_supported: ["code"] },
      verifyToken: { verifyAccessToken: async (token) => ({ token, clientId: "gemini", scopes: ["sovereign.mcp"],
        resource: new URL(endpoint), expiresAt: Date.now() / 1000 + 60 }) },
      localConnection: connection(first, "old-local-fixture-key-12345"),
      reloadLocalConnection: async () => connection(second, "new-local-fixture-key-12345"),
    });
    const url = await listen(app) + "/mcp";
    const post = (method: string, params: object, session?: string) => fetch(url, { method: "POST",
      headers: { Authorization: "Bearer google-fixture", "Content-Type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const initialized = await post("initialize", {});
    const front = initialized.headers.get("mcp-session-id")!; await initialized.arrayBuffer();
    oldAvailable = false;
    const action = { name: "files_write", arguments: { path: "fixture.txt", text: "one request" } };
    const written = await post("tools/call", action, front);
    expect((await written.json()).result.content[0].text).toBe("written once");
    expect(calls).toBe(1);
    unknown = true;
    const uncertain = await post("tools/call", action, front);
    expect(uncertain.status).toBe(502); await uncertain.arrayBuffer();
    expect(calls).toBe(2);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  }
});
