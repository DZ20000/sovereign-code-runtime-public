import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createGeminiGatewayBridge } from "../src/gemini-gateway-bridge.js";

const servers: Server[] = [];
const bridges: Array<Awaited<ReturnType<typeof createGeminiGatewayBridge>>> = [];
const endpoint = "https://gemini.example.test/mcp";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture(startupSignal?: AbortSignal) {
  const entered = deferred();
  const release = deferred();
  const downstreamClosed = deferred();
  let hold: "manifest" | "initialize" | null = null;
  let oldAvailable = true;
  let writes = 0;
  let initialized = 0;
  const oldId = "10000000-0000-4000-8000-000000000001";
  const newId = "10000000-0000-4000-8000-000000000002";
  const gateway = (id: string): RequestListener => async (req, res) => {
    if (id === oldId && !oldAvailable) { res.writeHead(401).end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/manifest") {
      if (hold === "manifest") { entered.resolve(); await release.promise; }
      res.end(JSON.stringify({ tools: [{ name: "files.write" }] })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "initialize") {
      if (hold === "initialize" && id === newId) { entered.resolve(); await release.promise; }
      res.setHeader("Mcp-Session-Id", id);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25" } }));
      return;
    }
    if (message.method === "notifications/initialized") {
      initialized++;
      res.writeHead(202).end(); return;
    }
    if (message.method === "tools/call") writes++;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
  };
  const first = await listen(gateway(oldId));
  const second = await listen(gateway(newId));
  const connection = (base: string) => ({
    schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
    transport: { type: "streamable-http", url: base + "/mcp",
      headers: { Authorization: "Bearer fixture-local-key-12345" } },
  });
  const bridge = await createGeminiGatewayBridge({
    publicEndpoint: endpoint,
    authorizationServer: {
      issuer: "https://login.example.test", authorization_endpoint: "https://login.example.test/authorize",
      token_endpoint: "https://login.example.test/token", response_types_supported: ["code"],
    },
    verifyToken: { verifyAccessToken: async (token) => ({
      token, clientId: "gemini", scopes: ["sovereign.mcp"], resource: new URL(endpoint),
      expiresAt: Date.now() / 1000 + 60,
    }) },
    localConnection: connection(first),
    reloadLocalConnection: async () => connection(second),
    ...(startupSignal === undefined ? {} : { startupSignal }),
  });
  bridges.push(bridge);
  const url = await listen((req, res) => {
    if (hold !== null) res.once("close", downstreamClosed.resolve);
    bridge(req, res);
  }) + "/mcp";
  const post = (method: string, params: object, session?: string, signal?: AbortSignal) => fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer fixture-oauth-token", "Content-Type": "application/json",
      ...(session === undefined ? {} : { "Mcp-Session-Id": session }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...(signal === undefined ? {} : { signal }),
  });
  const response = await post("initialize", {});
  const session = response.headers.get("mcp-session-id")!;
  await response.arrayBuffer();
  return {
    bridge, entered, release, downstreamClosed, url,
    call: (signal?: AbortSignal) => post("tools/call", { name: "files_write", arguments: { path: "fixture.txt" } }, session, signal),
    block: (stage: "manifest" | "initialize") => { hold = stage; if (stage === "initialize") oldAvailable = false; },
    writes: () => writes, initialized: () => initialized,
  };
}

it.each(["manifest", "initialize"] as const)("cancels a disposed bridge while waiting for %s and never dispatches the pending write", async (stage) => {
  const f = await fixture();
  f.block(stage);
  const pending = f.call();
  await f.entered.promise;
  f.bridge.dispose();
  f.release.resolve();
  const response = await pending;
  expect(response.status).toBe(502);
  await response.arrayBuffer();
  expect(f.writes()).toBe(0);
  expect(f.initialized()).toBe(0);
  expect((await fetch(f.url)).status).toBe(503);
});

it("observes downstream cancellation before a manifest lookup completes", async () => {
  const f = await fixture();
  f.block("manifest");
  const downstream = new AbortController();
  const pending = f.call(downstream.signal).catch(() => null);
  await f.entered.promise;
  downstream.abort();
  await pending;
  // A rejected client fetch alone does not mean the server has received the TCP close.
  await f.downstreamClosed.promise;
  f.release.resolve();
  // A subsequent ping's manifest follows the released one on the same local fixture.
  const response = await fetch(f.url, { method: "POST",
    headers: { Authorization: "Bearer fixture-oauth-token", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  await response.arrayBuffer();
  expect(f.writes()).toBe(0);
});

it("does not reuse the startup deadline as the listener lifetime", async () => {
  const startup = new AbortController();
  const f = await fixture(startup.signal);
  startup.abort();
  const response = await f.call();
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(f.writes()).toBe(1);
});
