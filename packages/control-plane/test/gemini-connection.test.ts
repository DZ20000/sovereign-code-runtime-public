import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopGeminiConnectionConfigurationInput, SovereignConnectionBundle } from "@sovereign/control-plane-contract";
import { createGeminiGatewayBridge, createGeminiTokenVerifier, loadGeminiAuthorizationServer } from "@sovereign/gateway/runtime";
import { GeminiConnectionManager, type GeminiConnectionOptions } from "../src/gemini-connection.js";
import { GEMINI_CONNECTION_ERRORS as errors } from "../src/gemini-connection-settings.js";

vi.mock("@sovereign/gateway/runtime", async () => {
  const actual = await import("../../../apps/gateway/src/gemini-gateway-bridge.js");
  return {
    createGeminiGatewayBridge: vi.fn(actual.createGeminiGatewayBridge),
    createGeminiTokenVerifier: vi.fn(),
    loadGeminiAuthorizationServer: vi.fn(),
  };
});

const publicMcpUrl = "https://gemini.example.test/mcp";
const metadata = {
  issuer: "https://login.example.test",
  authorization_endpoint: "https://login.example.test/authorize",
  token_endpoint: "https://login.example.test/token",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};
const input = (): DesktopGeminiConnectionConfigurationInput => ({
  publicMcpUrl,
  oauthDiscoveryUrl: "https://login.example.test/.well-known/oauth-authorization-server",
  introspectionUrl: "http://127.0.0.1:43210/introspect",
  clientId: "gemini-fixture",
  loopbackPort: 0,
  ownerSubject: { action: "replace", value: " id " },
  introspectionAuthorization: { action: "replace", value: "Bearer fixture-private-authorization" },
});
const roots: string[] = [];
const servers: Server[] = [];
const managers: GeminiConnectionManager[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(loadGeminiAuthorizationServer).mockReset().mockResolvedValue(metadata);
  vi.mocked(createGeminiTokenVerifier).mockReset().mockImplementation(() => ({
    verifyAccessToken: async (token) => ({
      token, clientId: "gemini-fixture", scopes: ["sovereign.mcp"],
      resource: new URL(publicMcpUrl), expiresAt: Date.now() / 1000 + 60,
    }),
  }));
  vi.mocked(createGeminiGatewayBridge).mockClear();
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(allowAutomaticRestore = true) {
  const root = await mkdtemp(join(tmpdir(), "scr-gemini-manager-"));
  roots.push(root);
  const settingsPath = join(root, "gemini-connection.json");
  const vault = new Map<string, string>();
  const shell = {
    protectSecret: vi.fn(async (value: string) => {
      if (!value || Buffer.byteLength(value, "utf8") > 4096 || /[\r\n\0]/u.test(value)) return null;
      const key = randomUUID();
      vault.set(key, value);
      return key;
    }),
    restoreSecret: vi.fn(async (encoded: string) => {
      // Match both existing shells: Electron trims; Tauri checks UTF-8 byte bounds.
      const value = vault.get(encoded)?.trim();
      if (!value || Buffer.byteLength(value, "utf8") < 16 || Buffer.byteLength(value, "utf8") > 4096) return null;
      return { value, encoded };
    }),
  };
  let authoritative = true;
  let available = true;
  let manifestWait: (() => Promise<void>) | undefined;
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-local-gateway-key") {
      res.writeHead(401).end(); return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/manifest") {
      await manifestWait?.();
      res.end(JSON.stringify({ tools: [{ name: "files.write" }] })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "tools/call") calls++;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection: SovereignConnectionBundle = {
    schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
    transport: { type: "streamable-http", url: "http://127.0.0.1:" + port + "/mcp",
      headers: { Authorization: "Bearer fixture-local-gateway-key" } },
  };
  const options: GeminiConnectionOptions = {
    userDataPath: root, shell, allowAutomaticRestore,
    localConnection: () => available ? connection : null,
    isAuthoritative: () => authoritative,
  };
  const manager = new GeminiConnectionManager(options);
  managers.push(manager);
  return {
    manager, shell, vault, settingsPath, connection, port,
    owner: (value: boolean) => { authoritative = value; },
    gateway: (value: boolean) => { available = value; },
    holdManifest: (wait: () => Promise<void>) => { manifestWait = wait; },
    calls: () => calls,
    readSaved: async () => JSON.parse(await readFile(settingsPath, "utf8")),
  };
}

describe("desktop Gemini connection management", () => {
  it("protects purpose-bound envelopes, keeps short exact subjects, and exposes only saved flags", async () => {
    const f = await fixture();
    expect((await f.manager.read()).phase).toBe("unconfigured");
    const saved = await f.manager.configure(input());
    expect(saved).toMatchObject({ phase: "saved", hasOwnerSubject: true, hasIntrospectionAuthorization: true });
    const disk = await readFile(f.settingsPath, "utf8");
    expect(disk).not.toContain(" id ");
    expect(disk).not.toContain("Bearer fixture-private-authorization");
    for (const [value] of f.shell.protectSecret.mock.calls) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(4096);
      expect(JSON.parse(value).schemaVersion).toBe("scr.gemini-protected-value/v1");
    }
    const running = await f.manager.start();
    expect(running.phase).toBe("listening");
    expect(running.listenEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(createGeminiTokenVerifier).toHaveBeenCalledWith(expect.objectContaining({
      ownerSubject: " id ", introspectionAuthorization: "Bearer fixture-private-authorization",
    }));
    expect(JSON.stringify(running)).not.toContain("Bearer fixture-private-authorization");
    expect(JSON.stringify(running)).not.toContain(" id ");
    const stopped = await f.manager.stop();
    expect(stopped).toMatchObject({ phase: "saved", listenEndpoint: null });
    expect((await f.readSaved()).enabled).toBe(false);
    await expect(fetch(running.listenEndpoint!)).rejects.toThrow();
  });

  it.each([
    { extra: true }, { publicMcpUrl: "http://example.test/mcp" },
    { oauthDiscoveryUrl: "https://name:secret@example.test/discovery" },
    { introspectionUrl: "http://example.test/introspect" }, { loopbackPort: 65536 },
    { ownerSubject: { action: "replace", value: "界".repeat(1400) } },
    { ownerSubject: { action: "keep", value: "unexpected" } },
    { introspectionAuthorization: { action: "replace", value: "Bearer bad\r\nHeader: value" } },
  ])("rejects invalid input before protected storage or persistence: %j", async (change) => {
    const f = await fixture();
    await expect(f.manager.configure({ ...input(), ...change } as DesktopGeminiConnectionConfigurationInput)).rejects.toThrow(errors.invalid);
    expect(f.shell.protectSecret).not.toHaveBeenCalled();
    await expect(readFile(f.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps saved secrets, forgets explicitly, and marks incomplete settings unconfigured", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    const original = await f.readSaved();
    await f.manager.configure({ ...input(), clientId: "changed", ownerSubject: { action: "keep" },
      introspectionAuthorization: { action: "keep" } });
    expect((await f.readSaved()).ownerSubjectEncrypted).toBe(original.ownerSubjectEncrypted);
    expect(f.shell.protectSecret).toHaveBeenCalledTimes(2);
    const forgotten = await f.manager.configure({ ...input(), ownerSubject: { action: "forget" },
      introspectionAuthorization: { action: "keep" } });
    expect(forgotten).toMatchObject({ phase: "unconfigured", hasOwnerSubject: false, hasIntrospectionAuthorization: true });
    expect((await f.manager.start()).phase).toBe("unconfigured");
    expect(loadGeminiAuthorizationServer).not.toHaveBeenCalled();
  });

  it("leaves the previous configuration intact when protection fails", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    const before = await readFile(f.settingsPath, "utf8");
    f.shell.protectSecret.mockRejectedValueOnce(new Error("fixture-secret-must-not-escape"));
    await expect(f.manager.configure({ ...input(), clientId: "must-not-save" })).rejects.toThrow(errors.protect);
    expect(await readFile(f.settingsPath, "utf8")).toBe(before);
  });

  it.each(["{ damaged", "x".repeat(65_537)])("preserves unreadable settings instead of overwriting them", async (contents) => {
    const f = await fixture();
    await writeFile(f.settingsPath, contents);
    expect(await f.manager.read()).toMatchObject({ phase: "error", lastError: errors.read });
    await expect(f.manager.configure(input())).rejects.toThrow(errors.read);
    expect(await readFile(f.settingsPath, "utf8")).toBe(contents);
    expect(f.shell.protectSecret).not.toHaveBeenCalled();
  });

  it("does not restore a ciphertext saved for the other credential purpose", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    const saved = await f.readSaved();
    [saved.ownerSubjectEncrypted, saved.introspectionAuthorizationEncrypted] =
      [saved.introspectionAuthorizationEncrypted, saved.ownerSubjectEncrypted];
    await writeFile(f.settingsPath, JSON.stringify(saved));
    expect(await f.manager.start()).toMatchObject({ phase: "error", lastError: errors.restore, listenEndpoint: null });
    expect(loadGeminiAuthorizationServer).not.toHaveBeenCalled();
  });

  it("leaves a listener owned by another service running after a port conflict", async () => {
    const f = await fixture();
    await f.manager.configure({ ...input(), loopbackPort: f.port });
    expect(await f.manager.start()).toMatchObject({ phase: "error", lastError: errors.port, listenEndpoint: null });
    const response = await fetch(new URL("/v1/manifest", f.connection.transport.url), {
      headers: f.connection.transport.headers,
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("cancels startup while discovery is pending and cannot revive after stop", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    const entered = deferred();
    let complete!: () => void;
    vi.mocked(loadGeminiAuthorizationServer).mockImplementationOnce((_url, signal) => new Promise((resolve, reject) => {
      complete = () => resolve(metadata);
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      entered.resolve();
    }));
    const starting = f.manager.start();
    await entered.promise;
    const stopping = f.manager.stop();
    await Promise.all([starting, stopping]);
    complete();
    expect(await f.manager.read()).toMatchObject({ phase: "saved", listenEndpoint: null });
    expect((await f.readSaved()).enabled).toBe(false);
    expect(createGeminiGatewayBridge).not.toHaveBeenCalled();
  });

  it("serializes saving, starting, and stopping without a late listener or lost configuration", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const protect = f.shell.protectSecret.getMockImplementation()!;
    f.shell.protectSecret.mockImplementationOnce(async (value) => {
      entered.resolve();
      await release.promise;
      return protect(value);
    });
    const saving = f.manager.configure(input());
    await entered.promise;
    const starting = f.manager.start();
    const stopping = f.manager.stop();
    release.resolve();
    await Promise.all([saving, starting, stopping]);
    expect(await f.manager.read()).toMatchObject({ phase: "saved", listenEndpoint: null, hasOwnerSubject: true });
    expect((await f.readSaved()).enabled).toBe(false);
    expect(loadGeminiAuthorizationServer).not.toHaveBeenCalled();
  });

  it("uses an independent enabled intent and restores only for an eligible active owner", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    await f.manager.start();
    await f.manager.suspend();
    expect((await f.readSaved()).enabled).toBe(true);
    f.owner(false);
    vi.mocked(loadGeminiAuthorizationServer).mockClear();
    await f.manager.restore();
    expect(loadGeminiAuthorizationServer).not.toHaveBeenCalled();
    await expect(f.manager.start()).rejects.toThrow(errors.owner);
    f.owner(true);
    expect((await f.manager.restore()).phase).toBe("listening");
    await f.manager.stop();
    await f.manager.restore();
    expect((await f.manager.read()).phase).toBe("saved");
  });

  it("never automatically contacts OAuth from an isolated controller, even with saved enabled intent", async () => {
    const f = await fixture(false);
    await f.manager.configure(input());
    await f.manager.start();
    await f.manager.suspend();
    vi.mocked(loadGeminiAuthorizationServer).mockClear();
    expect((await f.manager.restore()).phase).toBe("saved");
    expect(loadGeminiAuthorizationServer).not.toHaveBeenCalled();
    expect((await f.readSaved()).enabled).toBe(true);
  });

  it("bounds a stalled read-only secret restore without a late listener", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    const entered = deferred();
    f.shell.restoreSecret.mockImplementationOnce(async () => { entered.resolve(); return new Promise(() => {}); });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const starting = f.manager.start();
    await entered.promise;
    deadline.abort();
    expect(await starting).toMatchObject({ phase: "error", lastError: errors.timeout, listenEndpoint: null });
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(loadGeminiAuthorizationServer).not.toHaveBeenCalled();
  });

  it("disposes requests waiting for the manifest before stop returns, so no tool write can follow", async () => {
    const f = await fixture();
    await f.manager.configure(input());
    const running = await f.manager.start();
    const entered = deferred();
    const release = deferred();
    f.holdManifest(async () => { entered.resolve(); await release.promise; });
    const request = fetch(running.listenEndpoint!, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "files_write", arguments: { path: "fixture.txt", text: "must-not-write" } } }),
    }).then((response) => response.arrayBuffer(), () => null);
    await entered.promise;
    await f.manager.stop();
    release.resolve();
    await request;
    expect(f.calls()).toBe(0);
    expect((await f.manager.read()).listenEndpoint).toBeNull();
  });
});
