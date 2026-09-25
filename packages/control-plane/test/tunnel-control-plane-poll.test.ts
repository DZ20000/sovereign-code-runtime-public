import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_FIRST_POLL_DEADLINE_MS,
  CONTROL_PLANE_POLL_FRESHNESS_MS,
  judgeControlPlanePoll,
  lastSuccessfulPollMs,
  readLastSuccessfulPollMs,
} from "../src/tunnel-control-plane-poll.js";
import { classifyTunnelFailureEvidence } from "../src/tunnel-failure-classifier.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function metricsServer(status: number, body: string): Promise<string> {
  const server = createServer((request, response) => {
    response.statusCode = request.url === "/metrics" ? status : 404;
    response.end(request.url === "/metrics" ? body : "");
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("control-plane poll metric", () => {
  it("reads the timestamp the connector publishes, labels and exponent included", () => {
    expect(lastSuccessfulPollMs(
      'commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} 1.789700845e+09',
    )).toBe(1_789_700_845_000);
    expect(lastSuccessfulPollMs("commands_poll_last_successful_timestamp_seconds 1789700845")).toBe(1_789_700_845_000);
  });

  it.each([
    "# HELP commands_poll_last_successful_timestamp_seconds Unix timestamp in seconds of the last successful poll.",
    "commands_poll_errors_total 3",
    "commands_poll_last_successful_timestamp_seconds 0",
    "commands_poll_last_successful_timestamp_seconds NaN",
    "",
  ])("ignores a line that is not a usable timestamp: %j", (line) => {
    expect(lastSuccessfulPollMs(line)).toBeNull();
  });

  it("finds the metric after a long exposition and reports its absence as null", async () => {
    const histograms = Array.from({ length: 5_000 }, (_, index) =>
      `command_end_to_end_latency_milliseconds_bucket{le="${index}"} 0`).join("\n");
    const polling = await metricsServer(200,
      `${histograms}\ncommands_poll_last_successful_timestamp_seconds 1789700845\ngo_goroutines 12\n`);
    await expect(readLastSuccessfulPollMs(polling)).resolves.toBe(1_789_700_845_000);
    const silent = await metricsServer(200, `${histograms}\ncommands_poll_cycles_total 7`);
    await expect(readLastSuccessfulPollMs(silent)).resolves.toBeNull();
  });

  it("treats an unreadable metrics endpoint as an error rather than as an idle poller", async () => {
    const broken = await metricsServer(500, "internal error");
    await expect(readLastSuccessfulPollMs(broken)).rejects.toThrow(/HTTP 500/u);
  });
});

describe("control-plane poll verdict", () => {
  const started = 1_000_000;

  it("is ready while a poll has succeeded recently", () => {
    expect(judgeControlPlanePoll(started + 5_000, started, started + 10_000)).toEqual({ ready: true });
  });

  it("accepts a whole-second poll timestamp from the same second as startup", () => {
    const timing = { deadlineMs: 200, freshnessMs: 1_000 };
    const attemptStartedAtMs = 2_000_750;
    expect(judgeControlPlanePoll(2_000_000, attemptStartedAtMs, 2_000_900, timing)).toEqual({
      ready: true,
    });
    expect(judgeControlPlanePoll(1_999_000, attemptStartedAtMs, 2_000_900, timing)).toEqual({
      ready: null,
    });
  });

  it("gives a new connector its first long poll before judging the route", () => {
    // A long poll with nothing queued holds for up to 30s, so no completed
    // poll yet is the normal state of a healthy connector that just started.
    expect(judgeControlPlanePoll(null, started, started + 30_000)).toEqual({ ready: null });
    expect(judgeControlPlanePoll(started - 1, started, started + 30_000)).toEqual({ ready: null });
    expect(judgeControlPlanePoll(null, started, started + CONTROL_PLANE_FIRST_POLL_DEADLINE_MS)).toEqual({ ready: null });
    const late = judgeControlPlanePoll(null, started, started + CONTROL_PLANE_FIRST_POLL_DEADLINE_MS + 1);
    expect(late).toMatchObject({ ready: false });
    expect(late.ready === false ? late.detail : "").toMatch(/has not completed a control-plane poll/u);
  });

  it("leaves room for at least two full long-poll cycles", () => {
    expect(CONTROL_PLANE_FIRST_POLL_DEADLINE_MS).toBeGreaterThanOrEqual(2 * 30_000);
  });

  it("fails the route once polls have stopped, however well it started", () => {
    const now = started + 10 * 60_000;
    const verdict = judgeControlPlanePoll(now - CONTROL_PLANE_POLL_FRESHNESS_MS - 1, started, now);
    expect(verdict).toMatchObject({ ready: false });
    expect(verdict.ready === false ? verdict.detail : "").toMatch(/last successful control-plane poll/u);
  });

  it("honours shorter timing supplied by the supervisor", () => {
    const timing = { deadlineMs: 200, freshnessMs: 500 };
    expect(judgeControlPlanePoll(null, started, started + 200, timing)).toEqual({ ready: null });
    expect(judgeControlPlanePoll(null, started, started + 201, timing)).toMatchObject({ ready: false });
    expect(judgeControlPlanePoll(started + 100, started, started + 700, timing)).toMatchObject({ ready: false });
  });
});

describe("control-plane poll classification", () => {
  it("is a transport failure that warrants leaving the route", () => {
    expect(classifyTunnelFailureEvidence({
      source: "control-plane-poll",
      redactedText: "The connector has not completed a control-plane poll in 61s on this route.",
    })).toMatchObject({
      failureClass: "transport",
      confidence: "high",
      routeSwitchEligible: true,
      evidenceCode: "control-plane-poll-stale",
    });
  });
});
