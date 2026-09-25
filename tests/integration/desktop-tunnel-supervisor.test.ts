import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, utimesSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecureMcpTunnelController } from "../../apps/desktop/src/secure-tunnel.js";

const validTunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const cleanupPaths: string[] = [];
const originalTunnelClientPath = process.env.SCR_TUNNEL_CLIENT_PATH;
const managedEnvironmentKeys = [
  "HTTPS_PROXY",
  "http_proxy",
  "npm_config_https_proxy",
  "LOG_HTTP_RAW_UNSAFE",
  "MCP_SERVER_URL",
] as const;
const originalManagedEnvironment = new Map(
  managedEnvironmentKeys.map((key) => [key, process.env[key]] as const),
);

function launchNodeFixture(source: string, options: SpawnOptions): ChildProcess {
  return spawn(process.execPath, ["-e", source], options);
}

async function terminateFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      child.off("close", finish);
      resolveClose();
    };
    child.once("close", finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    timer = setTimeout(finish, 2_000);
    child.kill();
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

type SecureTunnelState = ReturnType<SecureMcpTunnelController["state"]>;
type FailureDiagnostic = NonNullable<SecureTunnelState["failureDiagnostic"]>;

async function waitForTunnelState(
  controller: SecureMcpTunnelController,
  predicate: (state: SecureTunnelState) => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<SecureTunnelState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = controller.state();
    if (predicate(state)) return state;
    await delay(20);
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(controller.state())}`,
  );
}

async function waitForFailureDiagnostic(
  controller: SecureMcpTunnelController,
  predicate: (diagnostic: FailureDiagnostic) => boolean,
  timeoutMs = 3_000,
): Promise<FailureDiagnostic> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostic = controller.state().failureDiagnostic;
    if (diagnostic !== null && predicate(diagnostic)) return diagnostic;
    await delay(20);
  }
  throw new Error(
    `Timed out waiting for tunnel failure diagnostic: ${JSON.stringify(controller.state().failureDiagnostic)}`,
  );
}

/**
 * A fake connector stands in for one that is reaching the control plane unless
 * a test says otherwise: /readyz alone does not prove that, so /metrics reports
 * a recent successful poll the way the real connector does. `polling: false`
 * models a connector that is locally ready but cannot reach the control plane,
 * and `pollsStopAfterMs` one whose polls stop succeeding partway through.
 */
async function listenLoopback(
  server: Server,
  options: { readonly polling?: boolean; readonly pollsStopAfterMs?: number; readonly pollsResumeWhen?: () => boolean } = {},
): Promise<string> {
  const handlers = server.listeners("request") as ((...args: unknown[]) => void)[];
  server.removeAllListeners("request");
  // Counted from the first time the supervisor asks, so the polls stop inside
  // the first attempt however long the host takes to start it.
  let firstAskedAt: number | null = null;
  server.on("request", (request, response) => {
    if (request.url === "/metrics") {
      firstAskedAt ??= Date.now();
      const lastPollSeconds = options.pollsStopAfterMs === undefined || options.pollsResumeWhen?.() === true
        ? Date.now() / 1_000
        : Math.min(Date.now(), firstAskedAt + options.pollsStopAfterMs) / 1_000;
      response.statusCode = 200;
      response.end(
        options.polling === false
          ? "commands_poll_cycles_total 7\n"
          : `commands_poll_last_successful_timestamp_seconds ${lastPollSeconds}\n`,
      );
      return;
    }
    for (const handler of handlers) handler.call(server, request, response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error("Readiness test server did not expose an address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

afterEach(async () => {
  if (originalTunnelClientPath === undefined) {
    delete process.env.SCR_TUNNEL_CLIENT_PATH;
  } else {
    process.env.SCR_TUNNEL_CLIENT_PATH = originalTunnelClientPath;
  }
  for (const key of managedEnvironmentKeys) {
    const value = originalManagedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Secure MCP Tunnel generation supervisor", () => {
  it("uses unique generation-bound health and PID files across reconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-generation-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    const healthFiles: string[] = [];
    const pidFiles: string[] = [];

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "generation-test",
      reconnectDelaysMs: [20],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => {
        const environment = options.env as NodeJS.ProcessEnv;
        healthFiles.push(environment.HEALTH_URL_FILE ?? "");
        pidFiles.push(environment.PID_FILE ?? "");
        return launchNodeFixture("setTimeout(() => process.exit(9), 10);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_GENERATION_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_GENERATION_1234",
      });
      const reconnectDeadline = Date.now() + 3_000;
      while (healthFiles.length < 2 && Date.now() < reconnectDeadline) {
        await delay(20);
      }
      expect(healthFiles.length).toBeGreaterThanOrEqual(2);
      expect(new Set(healthFiles).size).toBe(healthFiles.length);
      expect(new Set(pidFiles).size).toBe(pidFiles.length);
      expect(healthFiles.every((path) => dirname(path).endsWith("instance-generation-test"))).toBe(true);
      expect(healthFiles.every((path) => /attempt-\d+-health-url\.txt$/u.test(path))).toBe(true);
    } finally {
      await controller.stop();
    }
  });

  it("rejects a stale generation health file even when it contains loopback HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-stale-health-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "stale-health-test",
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 50,
      spawnConnector: (_executable, _args, options) => {
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, "http://127.0.0.1:65530", "utf8");
        const old = new Date(Date.now() - 60_000);
        utimesSync(healthFile, old, old);
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_STALE_1234",
    });
    controller.trustCurrentExecutable();

    try {
      const state = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_STALE_1234",
      });
      expect(state.phase).toBe("running");
      expect(state.healthUrl).toBeNull();
      expect(state.failureDiagnostic?.source).toBe("health-file");
      expect(state.failureDiagnostic?.routeSwitchEligible).toBe(false);
    } finally {
      await controller.stop();
    }
  });

  it("cleans inherited connector configuration and explicitly preserves loopback direct routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-environment-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    process.env.HTTPS_PROXY = "route-a";
    process.env.http_proxy = "route-b";
    process.env.npm_config_https_proxy = "route-c";
    process.env.LOG_HTTP_RAW_UNSAFE = "1";
    process.env.MCP_SERVER_URL = "http://wrong.example/mcp";
    const capturedEnvironments: NodeJS.ProcessEnv[] = [];

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "environment-test",
      startupReadyTimeoutMs: 30,
      spawnConnector: (_executable, _args, options) => {
        capturedEnvironments.push(options.env as NodeJS.ProcessEnv);
        return launchNodeFixture("setTimeout(() => process.exit(0), 10);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_ENVIRONMENT_1234",
    });
    controller.trustCurrentExecutable();
    await controller.start({
      gatewayEndpoint: "http://127.0.0.1:3210/mcp",
      gatewayBearerToken: "VALUE_GATEWAY_ENVIRONMENT_1234",
    });
    await delay(40);

    const capturedEnvironment = capturedEnvironments[0];
    expect(capturedEnvironment).toBeDefined();
    if (capturedEnvironment === undefined) {
      throw new Error("Connector environment was not captured.");
    }
    expect(capturedEnvironment.HTTPS_PROXY).toBeUndefined();
    expect(capturedEnvironment.http_proxy).toBeUndefined();
    expect(capturedEnvironment.npm_config_https_proxy).toBeUndefined();
    expect(capturedEnvironment.LOG_HTTP_RAW_UNSAFE).toBeUndefined();
    expect(capturedEnvironment.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(capturedEnvironment.MCP_SERVER_URL).toBe("http://127.0.0.1:3210/mcp");
    await controller.stop();
  });

  it("redacts connector output before retaining the bounded log tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-redaction-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    const runtimeValue = "VALUE_RUNTIME_REDACTION_1234";
    const gatewayValue = "VALUE_GATEWAY_REDACTION_1234";
    const proxyValue = "http://user:VALUE_PROXY_REDACTION_1234@proxy.example:8080";

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "redaction-test",
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => launchNodeFixture(
        "const value=process.env.CONTROL_PLANE_API_KEY||'';" +
        "process.stdout.write(value.slice(0,10));" +
        "setTimeout(()=>{" +
        "process.stdout.write(value.slice(10)+'\\n');" +
        "console.error(process.env.SCR_GATEWAY_AUTH_HEADER);" +
        "console.log(process.env.SCR_TUNNEL_CONTROL_PLANE_PROXY_URL);" +
        "setTimeout(() => process.exit(7), 5);" +
        "},5);",
        options,
      ),
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: runtimeValue,
      controlPlaneProxyUrl: proxyValue,
    });
    controller.trustCurrentExecutable();
    try {
      await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: gatewayValue,
      });
      const completed = await waitForTunnelState(
        controller,
        (state) => state.processId === null && state.phase === "error",
        "the connector to exit after writing all split log chunks",
      );
      const logTail = completed.logTail;
      expect(logTail).not.toContain(runtimeValue);
      expect(logTail).not.toContain(gatewayValue);
      expect(logTail).not.toContain(proxyValue);
      expect(logTail).not.toContain("VALUE_PROXY_REDACTION_1234");
      expect(logTail).toContain("[REDACTED]");
    } finally {
      await controller.stop();
    }
  });

  it("classifies a non-ready response body and clears it after recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-readyz-classification-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let statusCode = 503;
    let responseBody = `mcp probe failed: local endpoint unavailable ${"x".repeat(5_000)}`;
    const server = createServer((_request, response) => {
      response.statusCode = statusCode;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(responseBody);
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "readyz-classification-test",
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => {
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_READYZ_1234",
    });
    controller.trustCurrentExecutable();

    try {
      const pending = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_READYZ_1234",
      });
      expect(pending.failureDiagnostic).toMatchObject({
        failureClass: "local-mcp",
        source: "readyz",
        statusCode: 503,
        routeSwitchEligible: false,
      });
      expect(pending.failureDiagnostic?.detail.length).toBeLessThanOrEqual(512);

      statusCode = 200;
      responseBody = "ready";
      const recovered = await controller.refresh();
      expect(recovered.phase).toBe("ready");
      expect(recovered.failureDiagnostic).toBeNull();
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("classifies an unreachable local health endpoint as a connector health-probe failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-health-probe-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    const server = createServer();
    const unavailableHealthUrl = await listenLoopback(server);
    await closeServer(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "health-probe-test",
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => {
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, unavailableHealthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_HEALTH_PROBE_1234",
    });
    controller.trustCurrentExecutable();

    try {
      const state = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_HEALTH_PROBE_1234",
      });
      expect(state.failureDiagnostic).toMatchObject({
        failureClass: "connector",
        source: "health-probe",
        routeSwitchEligible: false,
      });
    } finally {
      await controller.stop();
    }
  });

  it("keeps specific authorization evidence when the connector later exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-auth-diagnostic-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "auth-diagnostic-test",
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => launchNodeFixture(
        "console.error('control-plane poll returned 403 forbidden: required permission missing');" +
        "setTimeout(() => process.exit(7), 10);",
        options,
      ),
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_AUTH_DIAGNOSTIC_1234",
    });
    controller.trustCurrentExecutable();

    await controller.start({
      gatewayEndpoint: "http://127.0.0.1:3210/mcp",
      gatewayBearerToken: "VALUE_GATEWAY_AUTH_DIAGNOSTIC_1234",
    });
    const diagnostic = await waitForFailureDiagnostic(
      controller,
      (candidate) =>
        candidate.failureClass === "auth" &&
        candidate.source === "connector-log",
    );
    expect(diagnostic).toMatchObject({
      failureClass: "auth",
      source: "connector-log",
      routeSwitchEligible: false,
    });
    const stopped = await controller.stop();
    expect(stopped.failureDiagnostic).toBeNull();
  });

  it("marks only explicit control-plane transport evidence as route-switch eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-transport-diagnostic-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "transport-diagnostic-test",
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => launchNodeFixture(
        "console.error('control-plane proxy connect failed: dial tcp: no such host');" +
        "setInterval(() => {}, 1000);",
        options,
      ),
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_TRANSPORT_DIAGNOSTIC_1234",
      controlPlaneProxyUrl: "http://proxy.example.test:8080",
    });
    controller.trustCurrentExecutable();

    try {
      await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_TRANSPORT_DIAGNOSTIC_1234",
      });
      const diagnostic = await waitForFailureDiagnostic(
        controller,
        (candidate) =>
          candidate.failureClass === "transport" &&
          candidate.source === "connector-log",
      );
      expect(diagnostic).toMatchObject({
        failureClass: "transport",
        source: "connector-log",
        confidence: "high",
        routeSwitchEligible: true,
      });
    } finally {
      await controller.stop();
    }
  });

  it("preserves stronger transport evidence while a retry has only an unknown readiness timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-diagnostic-retry-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "diagnostic-retry-test",
      reconnectDelaysMs: [20],
      startupReadyTimeoutMs: 40,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        return attemptCount === 1
          ? launchNodeFixture(
              "console.error('control-plane poll failed: connection refused');" +
              "setTimeout(() => process.exit(7), 10);",
              options,
            )
          : launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_DIAGNOSTIC_RETRY_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_DIAGNOSTIC_RETRY_1234",
      });
      const retryState = await waitForTunnelState(
        controller,
        (state) =>
          attemptCount >= 2 &&
          state.phase === "running" &&
          state.errorMessage?.includes("running but /readyz is not ready yet.") === true,
        "the reconnect attempt to reach its unknown readiness-timeout state",
      );
      expect(attemptCount).toBeGreaterThanOrEqual(2);
      expect(retryState.failureDiagnostic).toMatchObject({
        failureClass: "transport",
        routeSwitchEligible: true,
      });
    } finally {
      await controller.stop();
    }
  });
  it("recycles a previously ready connector after consecutive readiness failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-readiness-recycle-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let statusCode = 200;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = statusCode;
      response.end(statusCode === 200 ? "ready" : "control-plane temporarily unavailable");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "readiness-recycle-test",
      reconnectDelaysMs: [20],
      reconnectStabilityWindowMs: 100,
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        if (attemptCount >= 2) statusCode = 200;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_READINESS_RECYCLE_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const ready = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_READINESS_RECYCLE_1234",
      });
      expect(ready.phase).toBe("ready");
      statusCode = 503;

      const provisionalRecovery = await waitForTunnelState(
        controller,
        (state) =>
          attemptCount >= 2 &&
          state.phase === "ready" &&
          state.reconnectAttempt > 0,
        "a fresh but not-yet-stable connector generation after readiness loss",
      );
      expect(attemptCount).toBeGreaterThanOrEqual(2);
      expect(provisionalRecovery.reconnectAttempt).toBe(1);

      const stabilized = await waitForTunnelState(
        controller,
        (state) => state.phase === "ready" && state.reconnectAttempt === 0,
        "reconnect backoff to reset after stable readiness",
      );
      expect(stabilized.reconnectAttempt).toBe(0);
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("preserves reconnect backoff across short-lived ready generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-unstable-ready-backoff-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "unstable-ready-backoff-test",
      reconnectDelaysMs: [20, 40, 80],
      reconnectStabilityWindowMs: 1_500,
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return attemptCount <= 3
          ? launchNodeFixture("setTimeout(() => process.exit(1), 60);", options)
          : launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_UNSTABLE_BACKOFF_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const initial = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_UNSTABLE_BACKOFF_1234",
      });
      expect(initial.phase).toBe("ready");

      const provisional = await waitForTunnelState(
        controller,
        (state) =>
          attemptCount >= 4 &&
          state.phase === "ready" &&
          state.reconnectAttempt >= 3,
        "reconnect backoff to survive repeated short-lived ready states",
      );
      expect(provisional.reconnectAttempt).toBe(3);

      const stabilized = await waitForTunnelState(
        controller,
        (state) => state.phase === "ready" && state.reconnectAttempt === 0,
        "stable ready generation to reset reconnect backoff",
      );
      expect(stabilized.reconnectAttempt).toBe(0);
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("rebuilds a ready connector after a network-path change and requires stable readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-ready-network-change-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);
    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "ready-network-change-test",
      reconnectDelaysMs: [1_000, 2_000],
      reconnectStabilityWindowMs: 100,
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_READY_NETWORK_CHANGE_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);
    try {
      const initial = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_READY_NETWORK_CHANGE_1234",
      });
      expect(initial.phase).toBe("ready");
      expect(initial.reconnectAttempt).toBe(0);
      const changed = await controller.refresh({ networkChanged: true });
      expect(attemptCount).toBe(2);
      expect(changed.phase).toBe("ready");
      expect(changed.reconnectAttempt).toBe(1);
      const stabilized = await waitForTunnelState(
        controller,
        (state) => state.phase === "ready" && state.reconnectAttempt === 0,
        "network-change connector to remain ready through the stability window",
      );
      expect(stabilized.reconnectAttempt).toBe(0);
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("wakes a pending reconnect immediately after a network-path change without resetting backoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-network-wakeup-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "network-wakeup-test",
      reconnectDelaysMs: [1_000, 2_000],
      reconnectStabilityWindowMs: 500,
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return attemptCount === 1
          ? launchNodeFixture("setTimeout(() => process.exit(1), 80);", options)
          : launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_NETWORK_WAKEUP_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const initial = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_NETWORK_WAKEUP_1234",
      });
      expect(initial.phase).toBe("ready");

      const waiting = await waitForTunnelState(
        controller,
        (state) =>
          attemptCount === 1 &&
          state.reconnectAttempt === 1 &&
          state.nextReconnectAt !== null,
        "the first bounded reconnect delay",
      );
      expect(waiting.reconnectAttempt).toBe(1);

      const wakeStartedAt = Date.now();
      const woken = await controller.refresh({ networkChanged: true });
      expect(Date.now() - wakeStartedAt).toBeLessThan(750);
      expect(attemptCount).toBe(2);
      expect(woken.phase).toBe("ready");
      expect(woken.reconnectAttempt).toBe(1);
      expect(woken.nextReconnectAt).toBeNull();
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("keeps a ready connector whose logs report failures while its polls continue", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-log-advisory-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "transport-log-advisory-test",
      reconnectDelaysMs: [20],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        // One broken poll stream and one slow MCP request. Recycling on either
        // cut every request in flight and ended the sessions riding on them.
        return launchNodeFixture(
          "setTimeout(() => console.error('control-plane polling connection reset by peer'), 80);" +
            "setTimeout(() => console.error('dispatcher received MCP upstream error; posted error response to control plane: context deadline exceeded'), 120);" +
            "setInterval(() => {}, 1000);",
          options,
        );
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_TRANSPORT_ADVISORY_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const ready = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_TRANSPORT_ADVISORY_1234",
      });
      expect(ready.phase).toBe("ready");

      await waitForTunnelState(
        controller,
        (state) => state.logTail.includes("dispatcher received"),
        "both connector warnings to reach the bounded log tail",
      );
      await delay(200);
      expect(attemptCount).toBe(1);
      expect(controller.state().phase).toBe("ready");
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("keeps a ready connector that answers its health checks late on a busy host", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-late-answer-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    let busy = false;
    const server = createServer((_request, response) => {
      const ready = (): void => {
        response.statusCode = 200;
        response.end("ready");
      };
      if (busy) setTimeout(ready, 300);
      else ready();
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "late-answer-test",
      reconnectDelaysMs: [20],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      localProbeTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_LATE_ANSWER_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const ready = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_LATE_ANSWER_1234",
      });
      expect(ready.phase).toBe("ready");

      // Every health check now outlasts its timeout, well past the three
      // failures that used to recycle the connector and cut its requests.
      busy = true;
      const phases = new Set<string>();
      const until = Date.now() + 1_000;
      while (Date.now() < until) {
        phases.add(controller.state().phase);
        await delay(20);
      }
      busy = false;
      await delay(200);
      expect([...phases]).toEqual(["ready"]);
      expect(attemptCount).toBe(1);
      expect(controller.state().phase).toBe("ready");
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("recycles a connector that stays silent past the poll freshness window", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-silent-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    let silentAttempt = 0;
    const server = createServer((_request, response) => {
      if (attemptCount === silentAttempt) return;
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "silent-connector-test",
      reconnectDelaysMs: [20],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      localProbeTimeoutMs: 100,
      controlPlanePollFreshnessMs: 400,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_SILENT_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const ready = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_SILENT_1234",
      });
      expect(ready.phase).toBe("ready");

      silentAttempt = 1;
      const recovered = await waitForTunnelState(
        controller,
        (state) => attemptCount >= 2 && state.phase === "ready",
        "a fresh connector after the old one stopped answering",
      );
      expect(recovered.failureDiagnostic).toBeNull();
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("recycles a ready connector once its polls stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-stale-poll-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    // The replacement connector must supply new poll evidence. Reusing the
    // first generation's frozen timestamp forever cannot establish recovery.
    const healthUrl = await listenLoopback(server, {
      pollsStopAfterMs: 300,
      pollsResumeWhen: () => attemptCount >= 2,
    });

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "stale-poll-recycle-test",
      reconnectDelaysMs: [20],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      controlPlanePollFreshnessMs: 1_000,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_STALE_POLL_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const ready = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_STALE_POLL_1234",
      });
      expect(ready.phase).toBe("ready");

      const recovered = await waitForTunnelState(
        controller,
        (state) => attemptCount >= 2 && state.phase === "ready",
        "a fresh connector generation after the polls stopped",
      );
      expect(attemptCount).toBeGreaterThanOrEqual(2);
      expect(recovered.failureDiagnostic).toBeNull();
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("keeps a ready connector while the connector reports its own retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-self-retry-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "self-retry-log-test",
      reconnectDelaysMs: [20],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        return launchNodeFixture(
          "setTimeout(() => console.error('poll failed; backing off: Get https://api.openai.com/v1/tunnels/example/poll: EOF retry_in_ms=401'), 80);" +
            "setInterval(() => {}, 1000);",
          options,
        );
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_SELF_RETRY_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      const ready = await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_SELF_RETRY_1234",
      });
      expect(ready.phase).toBe("ready");

      const observed = await waitForTunnelState(
        controller,
        (state) => state.logTail.includes("backing off"),
        "the connector retry warning to reach the bounded log tail",
      );
      expect(observed.phase).toBe("ready");

      await delay(200);
      const held = controller.state();
      expect(attemptCount).toBe(1);
      expect(held.phase).toBe("ready");
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });

  it("restarts the reconnect ladder after a network-path change", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-network-ladder-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let attemptCount = 0;
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    const healthUrl = await listenLoopback(server);

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "legacy-health.txt"),
      attemptInstanceId: "network-ladder-test",
      reconnectDelaysMs: [20, 40, 60_000],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 100,
      spawnConnector: (_executable, _args, options) => {
        attemptCount += 1;
        const healthFile = (options.env as NodeJS.ProcessEnv).HEALTH_URL_FILE!;
        writeFileSync(healthFile, healthUrl, "utf8");
        // The first three connectors die at once so the ladder climbs to its
        // longest delay; the network change must not inherit that delay.
        return attemptCount <= 3
          ? launchNodeFixture("process.exit(1);", options)
          : launchNodeFixture("setInterval(() => {}, 1000);", options);
      },
      terminateConnector: terminateFixture,
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "VALUE_RUNTIME_NETWORK_LADDER_1234",
    });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);

    try {
      await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "VALUE_GATEWAY_NETWORK_LADDER_1234",
      }).catch(() => undefined);

      const stalled = await waitForTunnelState(
        controller,
        (state) => state.reconnectAttempt >= 3 && state.nextReconnectAt !== null,
        "the reconnect ladder to reach its longest delay",
      );
      expect(stalled.reconnectAttempt).toBeGreaterThanOrEqual(3);

      const woken = await controller.refresh({ networkChanged: true });
      expect(woken.reconnectAttempt).toBe(1);
    } finally {
      await controller.stop();
      await closeServer(server);
    }
  });
});
