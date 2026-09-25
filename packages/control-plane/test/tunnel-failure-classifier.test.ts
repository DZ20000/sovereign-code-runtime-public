import { describe, expect, it } from "vitest";

import {
  classifyTunnelFailureEvidence,
  connectorReportsOwnRetry,
  tunnelFailureClassificationPriority,
} from "../src/tunnel-failure-classifier.js";

describe("tunnel failure classifier", () => {
  it("keeps OAuth discovery pending unclassified", () => {
    const result = classifyTunnelFailureEvidence({
      source: "readyz",
      statusCode: 503,
      redactedText: "oauth discovery pending",
    });
    expect(result).toMatchObject({
      failureClass: "unknown",
      confidence: "low",
      routeSwitchEligible: false,
      evidenceCode: "readyz-oauth-discovery-pending",
    });
  });

  it("classifies OAuth discovery and MCP probe failures as local MCP", () => {
    const oauth = classifyTunnelFailureEvidence({
      source: "readyz",
      statusCode: 503,
      redactedText: "oauth discovery failed: metadata endpoint unavailable",
    });
    const probe = classifyTunnelFailureEvidence({
      source: "readyz",
      statusCode: 503,
      redactedText: "mcp probe failed: local endpoint unavailable",
    });
    expect(oauth).toMatchObject({ failureClass: "local-mcp", confidence: "high" });
    expect(probe).toMatchObject({ failureClass: "local-mcp", confidence: "high" });
    expect(oauth.routeSwitchEligible).toBe(false);
    expect(probe.routeSwitchEligible).toBe(false);
  });

  it("keeps generic non-ready responses unknown", () => {
    const result = classifyTunnelFailureEvidence({
      source: "readyz",
      statusCode: 503,
      redactedText: "warming up",
    });
    expect(result.failureClass).toBe("unknown");
    expect(result.routeSwitchEligible).toBe(false);
  });

  it("separates control-plane authorization from Tunnel identity", () => {
    const authorization = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "control-plane poll returned 403 forbidden: required permission missing",
    });
    const identity = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "invalid tunnel ID: value has the wrong shape",
    });
    expect(authorization).toMatchObject({
      failureClass: "auth",
      confidence: "high",
      routeSwitchEligible: false,
    });
    expect(identity).toMatchObject({
      failureClass: "identity",
      confidence: "high",
      routeSwitchEligible: false,
    });
  });

  it("classifies loopback connection failure as local MCP", () => {
    const result = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "mcp probe failed: dial tcp 127.0.0.1:4111: connection refused",
    });
    expect(result.failureClass).toBe("local-mcp");
    expect(result.routeSwitchEligible).toBe(false);
  });

  it("allows only explicit control-plane transport evidence to be eligible", () => {
    const routeFailure = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "control-plane proxy connect failed: dial tcp: no such host",
      controlPlaneProxyConfigured: true,
    });
    const genericTimeout = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "operation timed out",
      controlPlaneProxyConfigured: true,
    });
    expect(routeFailure).toMatchObject({
      failureClass: "transport",
      confidence: "high",
      routeSwitchEligible: true,
    });
    expect(genericTimeout).toMatchObject({
      failureClass: "unknown",
      routeSwitchEligible: false,
    });
  });

  it("distinguishes loopback proxies from the local MCP target", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const result = classifyTunnelFailureEvidence({
        source: "connector-log",
        controlPlaneProxyConfigured: true,
        redactedText: `poll failed; component=controlplane; Get https://api.openai.com/v1/tunnels/example/poll: proxyconnect tcp: dial tcp ${host}:1: connectex: No connection could be made because the target machine actively refused it`,
      });
      expect(result).toMatchObject({ failureClass: "transport", routeSwitchEligible: true });
    }
    for (const text of [
      "dial tcp 127.0.0.1:4111: connection refused",
      "mcp probe failed: proxyconnect tcp: dial tcp 127.0.0.1:4111: connection refused",
    ]) {
      expect(classifyTunnelFailureEvidence({ source: "connector-log", redactedText: text }))
        .toMatchObject({ failureClass: "local-mcp", routeSwitchEligible: false });
    }
  });

  it("keeps local process and health-handshake failures non-routable", () => {
    for (const source of ["spawn", "process", "health-file", "health-probe"] as const) {
      const result = classifyTunnelFailureEvidence({
        source,
        redactedText: `${source} test diagnostic`,
      });
      expect(result.failureClass).toBe("connector");
      expect(result.routeSwitchEligible).toBe(false);
    }
  });

  it("bounds and flattens diagnostic detail", () => {
    const result = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: `first\nsecond ${"x".repeat(1_000)}`,
    });
    expect(result.detail).not.toContain("\n");
    expect(result.detail.length).toBeLessThanOrEqual(512);
  });

  it("prioritizes specific evidence over generic process exit", () => {
    const specific = classifyTunnelFailureEvidence({
      source: "readyz",
      statusCode: 503,
      redactedText: "mcp probe failed: local endpoint unavailable",
    });
    const process = classifyTunnelFailureEvidence({
      source: "process",
      redactedText: "connector exited with a non-zero code",
    });
    expect(tunnelFailureClassificationPriority(specific))
      .toBeGreaterThan(tunnelFailureClassificationPriority(process));
  });

  it("prioritizes non-routable auth evidence over transport evidence", () => {
    const authorization = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "control-plane poll returned 403 forbidden",
    });
    const transport = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "control-plane proxy connect failed: no such host",
      controlPlaneProxyConfigured: true,
    });
    expect(tunnelFailureClassificationPriority(authorization))
      .toBeGreaterThan(tunnelFailureClassificationPriority(transport));
  });

  it("treats a retrying control-plane poll EOF as transport rather than authorization", () => {
    const result = classifyTunnelFailureEvidence({
      source: "connector-log",
      controlPlaneProxyConfigured: true,
      redactedText:
        '{"level":"WARN","msg":"poll failed; backing off","component":"controlplane","error":"Get \\"https://api.openai.com/v1/tunnels/tunnel_example/poll?limit=20&timeout_ms=30000\\": EOF","retry_in_ms":401}',
    });
    expect(result).toMatchObject({
      failureClass: "transport",
      confidence: "high",
      routeSwitchEligible: true,
      evidenceCode: "log-control-plane-transport",
    });
  });

  it("never reads connector backoff or timeout numbers as HTTP status codes", () => {
    const result = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText:
        '{"msg":"poll failed; backing off","component":"controlplane","error":"Get https://api.openai.com/v1/tunnels/example/poll: unexpected EOF","retry_in_ms":403,"timeout_ms":401}',
    });
    expect(result.failureClass).toBe("transport");
  });

  it("still classifies explicit control-plane authorization evidence", () => {
    for (const text of [
      'control-plane poll failed {"status":401,"retry_in_ms":250}',
      "control-plane poll failed with HTTP 403",
      'control-plane request failed {"status_code":403}',
    ]) {
      expect(
        classifyTunnelFailureEvidence({ source: "connector-log", redactedText: text }),
      ).toMatchObject({ failureClass: "auth", routeSwitchEligible: false });
    }
  });

  it("detects a connector line that announces its own retry", () => {
    const retrying = classifyTunnelFailureEvidence({
      source: "connector-log",
      controlPlaneProxyConfigured: true,
      redactedText:
        "poll failed; backing off: Get https://api.openai.com/v1/tunnels/example/poll: EOF retry_in_ms=401",
    });
    const hardFailure = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: "control-plane polling connection reset by peer",
    });
    expect(connectorReportsOwnRetry(retrying)).toBe(true);
    expect(connectorReportsOwnRetry(hardFailure)).toBe(false);
    expect(connectorReportsOwnRetry({ source: "process", detail: "backing off" })).toBe(false);
  });

  it("reads a dispatcher error as one failed request, never as the route", () => {
    // These name the control plane only as where the reply went. The first, read
    // as a proxy failure, exhausted the route-switch budget and took the tunnel
    // down for seven minutes.
    for (const text of [
      '{"time":"2026-09-18T16:13:36.7579992+08:00","level":"WARN","msg":"dispatcher received MCP upstream error; posted error response to control plane","client_instance_id":"example","component":"dispatcher","request_id":"cmd_example","error":"Post \\"http://127.0.0.1:61099/mcp\\": context deadline exceeded"}',
      '{"level":"WARN","msg":"failed to post response to control plane","component":"dispatcher","error":"Post \\"https://api.openai.com/v1/tunnels/example/responses\\": EOF"}',
      "dispatcher failed to connect to MCP transport; posted error response to control plane: dial tcp 127.0.0.1:61099: connection refused",
      "failed to read response from MCP server: unexpected EOF",
    ]) {
      expect(classifyTunnelFailureEvidence({
        source: "connector-log",
        controlPlaneProxyConfigured: true,
        redactedText: text,
      })).toMatchObject({
        failureClass: "unknown",
        confidence: "low",
        routeSwitchEligible: false,
        evidenceCode: "log-dispatcher-request",
      });
    }
  });
});
