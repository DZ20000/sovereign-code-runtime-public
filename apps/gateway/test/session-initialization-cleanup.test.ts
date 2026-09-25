import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createPrincipal, PolicyEngine } from "@sovereign/runtime-core";
import { ToolCatalog } from "@sovereign/toolkit";
import { createGatewayApplication } from "../src/app.js";

it("releases rejected initialization resources while preserving a successful session", async () => {
  const catalog = new ToolCatalog([], new PolicyEngine(), "0.1.0");
  const subscribe = catalog.subscribe.bind(catalog);
  let subscriptions = 0;
  vi.spyOn(catalog, "subscribe").mockImplementation(listener => {
    subscriptions++;
    const unsubscribe = subscribe(listener);
    let live = true;
    return () => { if (live) { live = false; subscriptions--; } unsubscribe(); };
  });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = createGatewayApplication({
    runtimeVersion: "0.1.0", catalog, maxSessions: 1,
    bearerGrants: [{ token: "cleanup-test-token", principal: createPrincipal("cleanup-test", [], []) }],
    allowedHosts: [host], allowedOrigins: ["http://127.0.0.1"],
  });
  server.on("request", gateway.app);
  try {
    for (const accept of ["application/json", "application/json", "application/json, text/event-stream"]) {
      const response = await fetch(`http://${host}/mcp`, {
        method: "POST",
        headers: { accept, "content-type": "application/json", authorization: "Bearer cleanup-test-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      });
      await response.text();
      const successful = accept.includes("text/event-stream");
      expect(response.status).toBe(successful ? 200 : 406);
      await vi.waitFor(() => expect(subscriptions).toBe(successful ? 1 : 0));
    }
  } finally {
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  }
  expect(subscriptions).toBe(0);
});
