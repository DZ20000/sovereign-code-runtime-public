import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseGeminiLocalConnection, readRegisteredGeminiConnection,
  registerGeminiLocalConnection, refreshRegisteredGeminiConnection } from "../src/gemini-local-connection.js";

const connection = (port = 43123, token = "local-fixture-token-123456") => ({
  schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
  transport: { type: "streamable-http", url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` } },
});
it("accepts only an explicit loopback MCP connection without URL credentials", () => {
  expect(parseGeminiLocalConnection(connection())).toEqual(connection());
  for (const url of ["https://example.test/mcp", "http://localhost:1234/mcp",
    "http://127.0.0.1:1234/other", "http://user:password@127.0.0.1:1234/mcp",
    "http://127.0.0.1:1234/mcp?token=secret"]) {
    expect(() => parseGeminiLocalConnection({ ...connection(),
      transport: { ...connection().transport, url } })).toThrow();
  }
});
// Keep an overall deadline while each real protection process also has a bounded lifetime.
it.skipIf(process.platform !== "win32")("protects explicit local pairing and refreshes only an existing registration", async () => {
  const started = Date.now();
  const trace = (stage: string) => { if (process.env.CI) console.info("Local pairing stage: " + stage + " (" + (Date.now() - started) + " ms)"); };
  trace("begin");
  const root = await mkdtemp(join(tmpdir(), "so-gemini-pairing-"));
  const environment = { ...process.env, LOCALAPPDATA: root };
  trace("temporary directory ready");
  try {
    expect(await readRegisteredGeminiConnection(environment)).toBeNull();
    expect(await refreshRegisteredGeminiConnection(connection().transport.url, "unused-fixture-token", environment)).toBe(false);
    trace("empty registration verified");
    await registerGeminiLocalConnection(connection(), environment);
    trace("registered");
    const path = join(root, "Sovereign Code Runtime", "gemini", "sovereign-local-connection.dpapi");
    expect(await readFile(path, "utf8")).not.toContain("local-fixture-token");
    expect(await readRegisteredGeminiConnection(environment)).toEqual(connection());
    trace("restored");
    const next = connection(43124, "updated-fixture-token-123456");
    expect(await refreshRegisteredGeminiConnection(next.transport.url, "updated-fixture-token-123456", environment)).toBe(true);
    trace("refreshed");
    expect(await readRegisteredGeminiConnection(environment)).toEqual(next);
    trace("updated registration restored");
    expect(await refreshRegisteredGeminiConnection(next.transport.url, "updated-fixture-token-123456", environment)).toBe(false);
    trace("unchanged registration verified");
  } finally {
    trace("cleanup begin");
    await rm(root, { recursive: true, force: true });
    trace("cleanup complete");
  }
}, 60_000);
