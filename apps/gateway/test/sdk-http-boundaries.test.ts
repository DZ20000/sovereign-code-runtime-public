import { afterEach, describe, expect, it, vi } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

// Integration with the resolved SDK, not a substitute implementation or a live endpoint.
const transports: WebStandardStreamableHTTPServerTransport[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.close())); });
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
function transport(maxRequestBodySize = 2048) {
  const options = { sessionIdGenerator: undefined, maxRequestBodySize };
  const value = new WebStandardStreamableHTTPServerTransport(options);
  transports.push(value);
  return value;
}
function request(value: unknown) {
  return new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(value) });
}
function chunks(declaredLength?: string) {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads === 8) { controller.close(); return; }
      reads += 1;
      controller.enqueue(new Uint8Array(64).fill(32));
    },
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST", headers: { ...headers, ...(declaredLength ? { "content-length": declaredLength } : {}) },
    body, duplex: "half",
  };
  return { request: new Request("http://localhost/mcp", init), reads: () => reads };
}
const notification = (index: number) => ({ jsonrpc: "2.0", method: "notifications/initialized", params: { index } });

describe("resolved MCP SDK HTTP resource boundaries", () => {
  it("rejects an oversized declaration before pulling body bytes", async () => {
    const input = chunks("129");
    const handler = transport(128);
    const dispatched = vi.fn(); handler.onmessage = dispatched;
    const result = await handler.handleRequest(input.request);
    expect(result.status).toBe(413);
    expect(input.reads()).toBe(0);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("stops streaming on the first chunk over the byte budget", async () => {
    const input = chunks();
    const result = await transport(128).handleRequest(input.request);
    expect(result.status).toBe(413);
    expect(input.reads()).toBe(3);
  });

  it("accepts a valid Unicode message at the exact byte boundary", async () => {
    const value = { ...notification(1), params: { text: "中文🚀" } };
    const handler = transport(Buffer.byteLength(JSON.stringify(value)));
    const dispatched = vi.fn(); handler.onmessage = dispatched;
    expect((await handler.handleRequest(request(value))).status).toBe(202);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched.mock.calls[0]?.[0]).toEqual(value);
  });

  it.each(["streamed", "preparsed"] as const)("rejects oversized %s batches without dispatch", async mode => {
    const value = Array.from({ length: 101 }, (_, index) => notification(index));
    const handler = transport(64 * 1024);
    const dispatched = vi.fn(); handler.onmessage = dispatched;
    const result = await handler.handleRequest(request(value), mode === "preparsed" ? { parsedBody: value } : undefined);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code: -32600 } });
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("accepts all messages in a batch at the supported count limit", async () => {
    const value = Array.from({ length: 100 }, (_, index) => notification(index));
    const handler = transport(64 * 1024);
    const dispatched = vi.fn(); handler.onmessage = dispatched;
    expect((await handler.handleRequest(request(value), { parsedBody: value })).status).toBe(202);
    expect(dispatched).toHaveBeenCalledTimes(100);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid configured body bound %s", limit => {
    expect(() => transport(limit)).toThrow(RangeError);
  });
});
