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
// Allow for six real PowerShell/DPAPI cold starts on a shared Windows runner.
it.skipIf(process.platform !== "win32")("protects explicit local pairing and refreshes only an existing registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "so-gemini-pairing-"));
  const environment = { ...process.env, LOCALAPPDATA: root };
  try {
    expect(await readRegisteredGeminiConnection(environment)).toBeNull();
    expect(await refreshRegisteredGeminiConnection(connection().transport.url, "unused-fixture-token", environment)).toBe(false);
    await registerGeminiLocalConnection(connection(), environment);
    const path = join(root, "Sovereign Code Runtime", "gemini", "sovereign-local-connection.dpapi");
    expect(await readFile(path, "utf8")).not.toContain("local-fixture-token");
    expect(await readRegisteredGeminiConnection(environment)).toEqual(connection());
    const next = connection(43124, "updated-fixture-token-123456");
    expect(await refreshRegisteredGeminiConnection(next.transport.url, "updated-fixture-token-123456", environment)).toBe(true);
    expect(await readRegisteredGeminiConnection(environment)).toEqual(next);
    expect(await refreshRegisteredGeminiConnection(next.transport.url, "updated-fixture-token-123456", environment)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
