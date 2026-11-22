import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";
import { createGeminiGatewayBridge } from "../src/gemini-gateway-bridge.js";
import { startGatewayRuntime } from "../src/runtime.js";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZqNRAAAAAASUVORK5CYII=",
  "base64",
);
it("delivers the same real image through native MCP and the Gemini projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "so-mcp-image-"));
  const token = randomBytes(32).toString("base64url");
  let runtime: Awaited<ReturnType<typeof startGatewayRuntime>> | undefined;
  let client: Client | undefined;
  let bridge: Server | undefined;
  try {
    await writeFile(join(root, "sample.png"), image);
    runtime = await startGatewayRuntime({
      bearerToken: token, workspaceRoot: root, workspaceId: "image-test",
      auditPath: join(root, "audit.sqlite"), port: 0, externalPermissionProfile: "bypass",
      watchToolPacks: false, runCompletionNotificationsEnabled: false,
    });
    client = new Client({ name: "image-fixture-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(runtime.endpoint),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport as unknown as Transport);
    expect(runtime.manifest.tools.find(tool => tool.name === "files.read_image")).toMatchObject({
      permissionLevel: "workspace", approvalMode: "single-use",
      requiredCapabilities: ["files.read"], sideEffect: "read",
    });
    expect((await client.listTools()).tools.find(tool => tool.name === "files.read_image"))
      .toMatchObject({ annotations: { readOnlyHint: true } });
    const reply = await client.callTool({
      name: "files.read_image", arguments: { workspaceId: "image-test", path: "sample.png" },
    });
    expect(reply.isError).not.toBe(true);
    const expected = { type: "image", mimeType: "image/png", data: image.toString("base64") };
    expect(reply.content).toContainEqual(expected);
    expect(reply.structuredContent).toMatchObject({ result: { relativePath: "sample.png", bytes: image.length } });
    expect(JSON.stringify(reply.structuredContent)).not.toContain(image.toString("base64"));

    const publicEndpoint = "https://mcp.example.test/mcp";
    const issuer = "https://login.example.test";
    const app = await createGeminiGatewayBridge({
      publicEndpoint,
      authorizationServer: { issuer, authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token", response_types_supported: ["code"] },
      verifyToken: { verifyAccessToken: async (accessToken) => ({
        token: accessToken, clientId: "image-fixture-client", scopes: ["sovereign.mcp"],
        resource: new URL(publicEndpoint), expiresAt: Date.now() / 1000 + 60,
      }) },
      localConnection: { schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
        transport: { type: "streamable-http", url: runtime.endpoint, headers: { Authorization: `Bearer ${token}` } } },
    });
    bridge = createServer(app);
    await new Promise<void>(resolve => bridge!.listen(0, "127.0.0.1", resolve));
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback bridge");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const post = (method: string, params: object, session?: string) => fetch(endpoint, {
      method: "POST", headers: { Authorization: "Bearer gemini-image-fixture", "Content-Type": "application/json",
        ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const initial = await post("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "gemini-fixture", version: "1.0.0" },
    });
    expect(initial.status).toBe(200);
    const session = initial.headers.get("mcp-session-id") ?? "";
    await initial.arrayBuffer();
    await (await post("notifications/initialized", {}, session)).arrayBuffer();
    const listed = await (await post("tools/list", {}, session)).json();
    expect(listed.result.tools.find((tool: { name: string }) => tool.name === "files_read_image")).toBeDefined();
    const gemini = await (await post("tools/call", {
      name: "files_read_image", arguments: { workspaceId: "image-test", path: "sample.png" },
    }, session)).json();
    expect(gemini.result.isError).not.toBe(true);
    expect(gemini.result.content).toContainEqual(expected);
    expect(gemini.result).not.toHaveProperty("structuredContent");
    expect(gemini.result.content.filter((item: { type: string }) => item.type === "text")
      .every((item: { text: string }) => !item.text.includes(image.toString("base64")))).toBe(true);
  } finally {
    if (bridge) {
      bridge.closeAllConnections();
      await new Promise<void>(resolve => bridge!.close(() => resolve()));
    }
    await client?.close();
    await runtime?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
