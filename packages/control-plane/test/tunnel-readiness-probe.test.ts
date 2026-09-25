import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { askConnectorReadiness } from "../src/tunnel-readiness-probe.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  })));
});

async function connector(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function answer(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.end(body);
}

describe("connector readiness probe", () => {
  it("reports readiness with the last completed control-plane poll", async () => {
    const url = await connector((request, response) => answer(response, 200,
      request.url === "/metrics" ? "commands_poll_last_successful_timestamp_seconds 1789700845\n" : "ok"));
    await expect(askConnectorReadiness(url, 500)).resolves.toEqual({
      kind: "ready",
      lastSuccessfulPollMs: 1_789_700_845_000,
    });
  });

  it("passes on a non-ready answer with its status and body", async () => {
    const url = await connector((_request, response) => answer(response, 503, "mcp probe failed"));
    await expect(askConnectorReadiness(url, 500)).resolves.toEqual({
      kind: "not-ready",
      statusCode: 503,
      body: "mcp probe failed",
    });
  });

  it("calls a connector that answers too late unanswered, not failed", async () => {
    // A connector on a host saturated by other work answers late; that is not
    // evidence it is broken, and must not be read as such.
    const silentReadyz = await connector(() => undefined);
    await expect(askConnectorReadiness(silentReadyz, 100)).resolves.toMatchObject({
      kind: "unanswered",
      detail: expect.stringMatching(/did not answer \/readyz within 100 ms/u),
    });
    const silentMetrics = await connector((request, response) => {
      if (request.url !== "/metrics") answer(response, 200, "ok");
    });
    await expect(askConnectorReadiness(silentMetrics, 100)).resolves.toMatchObject({
      kind: "unanswered",
      detail: expect.stringMatching(/\/metrics/u),
    });
  });

  it("reports a refused connection or a broken metrics endpoint as a failure", async () => {
    const closed = await connector(() => undefined);
    const server = servers.pop()!;
    await new Promise((done) => server.close(done));
    await expect(askConnectorReadiness(closed, 500)).resolves.toMatchObject({ kind: "failed" });

    const brokenMetrics = await connector((request, response) =>
      answer(response, request.url === "/metrics" ? 500 : 200, "error"));
    await expect(askConnectorReadiness(brokenMetrics, 500)).resolves.toMatchObject({
      kind: "failed",
      detail: expect.stringMatching(/HTTP 500/u),
    });
  });
});
