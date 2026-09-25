import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneController } from "../../packages/control-plane/src/controller.js";
import {
  SecureMcpTunnelController,
  type SecureTunnelControllerOptions,
} from "../../packages/control-plane/src/secure-tunnel.js";

const validTunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const primaryProxyUrl = "http://primary.example.test:8080";
const backupProxyUrl = "http://backup.example.test:8080";
const cleanupPaths: string[] = [];
const originalTunnelClientPath = process.env.SCR_TUNNEL_CLIENT_PATH;

const transportFailureScript = [
  "console.error('poll failed; component=controlplane; Get https://api.openai.com/v1/tunnels/example/poll: proxyconnect tcp: dial tcp 127.0.0.1:1: connectex: No connection could be made because the target machine actively refused it');",
  "setInterval(() => {}, 1000);",
].join("");

const authorizationFailureScript = [
  "console.error('control-plane poll returned 403 forbidden: required permission missing');",
  "setInterval(() => {}, 1000);",
].join("");

// A connector that is reaching the control plane: /readyz alone does not prove
// that, so /metrics reports a recent successful poll as the real connector does.
const readyConnectorScript = [
  "const http=require('node:http');",
  "const fs=require('node:fs');",
  "const server=http.createServer((req,res)=>{res.statusCode=200;",
  "res.end(req.url==='/metrics'?'commands_poll_last_successful_timestamp_seconds '+Math.floor(Date.now()/1000):'ready');});",
  "server.listen(0,'127.0.0.1',()=>{",
  "const address=server.address();",
  "fs.writeFileSync(process.env.HEALTH_URL_FILE,`http://127.0.0.1:${address.port}`);",
  "});",
].join("");

// A healthy connector as it really starts: the metric moves only when a poll
// completes, and the first long poll stays open for a while before it does.
const slowFirstPollConnectorScript = [
  "const http=require('node:http');",
  "const fs=require('node:fs');",
  "const server=http.createServer((req,res)=>{res.statusCode=200;",
  "if(req.url!=='/metrics'){res.end('ready');return;}",
  "res.end(!fs.existsSync(process.env.HEALTH_URL_FILE+'.poll-completed')?'commands_poll_cycles_total 1':'commands_poll_last_successful_timestamp_seconds '+Date.now()/1000);});",
  "server.listen(0,'127.0.0.1',()=>{",
  "const address=server.address();",
  "fs.writeFileSync(process.env.HEALTH_URL_FILE,`http://127.0.0.1:${address.port}`);",
  "});",
].join("");

// Locally ready, silent in its logs, and never completing a poll: a route that
// cannot reach the control plane, such as a DNS-poisoned direct connection.
const readyWithoutControlPlaneScript = [
  "const http=require('node:http');",
  "const fs=require('node:fs');",
  "const server=http.createServer((req,res)=>{res.statusCode=200;",
  "res.end(req.url==='/metrics'?'commands_poll_cycles_total 7':'ready');});",
  "server.listen(0,'127.0.0.1',()=>{",
  "const address=server.address();",
  "fs.writeFileSync(process.env.HEALTH_URL_FILE,`http://127.0.0.1:${address.port}`);",
  "});",
].join("");

const localMcpFailureScript = [
  "const http=require('node:http');",
  "const fs=require('node:fs');",
  "const server=http.createServer((_req,res)=>{",
  "res.statusCode=503;res.end('mcp probe failed: local endpoint unavailable');",
  "});",
  "server.listen(0,'127.0.0.1',()=>{",
  "const address=server.address();",
  "fs.writeFileSync(process.env.HEALTH_URL_FILE,`http://127.0.0.1:${address.port}`);",
  "});",
].join("");

const genericNotReadyScript = [
  "const http=require('node:http');",
  "const fs=require('node:fs');",
  "const server=http.createServer((_req,res)=>{res.statusCode=503;res.end('warming up');});",
  "server.listen(0,'127.0.0.1',()=>{",
  "const address=server.address();",
  "fs.writeFileSync(process.env.HEALTH_URL_FILE,`http://127.0.0.1:${address.port}`);",
  "});",
].join("");

type RouteName = "primary" | "backup" | "direct";

type RouteBehavior = (
  route: RouteName,
  attempt: number,
  environment: NodeJS.ProcessEnv,
) => string;

interface RoutingHarness {
  readonly controller: ControlPlaneController;
  readonly spawnedRoutes: RouteName[];
  readonly environments: NodeJS.ProcessEnv[];
  readonly maximumActiveProcesses: () => number;
}

let harnessSequence = 0;

function routeFromEnvironment(environment: NodeJS.ProcessEnv): RouteName {
  const proxyUrl = environment.SCR_TUNNEL_CONTROL_PLANE_PROXY_URL;
  if (proxyUrl === undefined) return "direct";
  const parsed = new URL(proxyUrl);
  const display = `${parsed.protocol}//${parsed.host}`;
  if (display === primaryProxyUrl) return "primary";
  if (display === backupProxyUrl) return "backup";
  throw new Error(`Unexpected control-plane proxy route: ${display}`);
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

async function signalConnectorFixture(
  harness: RoutingHarness,
  signal: string,
): Promise<void> {
  const healthUrl = harness.controller.state().secureTunnel.healthUrl;
  if (healthUrl === null) {
    throw new Error("The active connector has not published its health URL.");
  }
  const response = await fetch(new URL(`/__test/${encodeURIComponent(signal)}`, healthUrl), {
    method: "POST",
    signal: AbortSignal.timeout(1_000),
  });
  if (response.status !== 204) {
    throw new Error(`Connector fixture signal ${signal} returned HTTP ${response.status}, expected 204.`);
  }
}

async function waitForState(
  controller: ControlPlaneController,
  predicate: (state: ReturnType<ControlPlaneController["state"]>) => boolean,
  timeoutMs = 5_000,
): Promise<ReturnType<ControlPlaneController["state"]>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = controller.state();
    if (predicate(state)) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for routing state: ${JSON.stringify(controller.state().secureTunnel)}`);
}

async function createRoutingHarness(
  behavior: RouteBehavior,
  policyOverrides: Readonly<Record<string, number>> = {},
  tunnelOverrides: Partial<SecureTunnelControllerOptions> = {},
): Promise<RoutingHarness> {
  const root = await mkdtemp(join(tmpdir(), "scr-tunnel-routing-"));
  cleanupPaths.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
  const spawnedRoutes: RouteName[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const attempts = new Map<RouteName, number>();
  let activeProcesses = 0;
  let maximumActiveProcesses = 0;
  harnessSequence += 1;

  const secureTunnelFactory = (
    tunnelOptions: SecureTunnelControllerOptions,
  ): SecureMcpTunnelController => new SecureMcpTunnelController({
    ...tunnelOptions,
    attemptInstanceId: `routing-test-${harnessSequence}`,
    reconnectDelaysMs: [20],
    healthProbeIntervalMs: 20,
    startupReadyTimeoutMs: 60,
    // A real Node child can take over 400 ms just to start on Windows. Keep
    // failure detection bounded without killing a healthy fixture before listen.
    controlPlanePollDeadlineMs: 1_500,
    ...tunnelOverrides,
    spawnConnector: (_executable, _args, spawnOptions: SpawnOptions) => {
      const environment = spawnOptions.env as NodeJS.ProcessEnv;
      const route = routeFromEnvironment(environment);
      const attempt = (attempts.get(route) ?? 0) + 1;
      attempts.set(route, attempt);
      spawnedRoutes.push(route);
      environments.push({ ...environment });
      const child = spawn(
        process.execPath,
        ["-e", behavior(route, attempt, environment)],
        spawnOptions,
      );
      activeProcesses += 1;
      maximumActiveProcesses = Math.max(maximumActiveProcesses, activeProcesses);
      child.once("close", () => {
        activeProcesses = Math.max(0, activeProcesses - 1);
      });
      return child;
    },
    terminateConnector: terminateFixture,
  });

  const controller = new ControlPlaneController({
    userDataPath: root,
    nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
    environmentWorkspaceRoot: workspaceRoot,
    shell: {
      chooseWorkspace: async () => null,
      chooseSecureTunnelExecutable: async () => null,
      protectSecret: async () => null,
      restoreSecret: async () => null,
      prompt: async () => 0,
    },
    approvalSurface: {
      present: async () => "deny",
    },
    secureTunnelFactory,
    controlPlaneFailoverPolicy: {
      transportFailureThreshold: 2,
      connectorRetryLimit: 1,
      sameRouteRetryDelayMs: 20,
      routeSwitchDelayMs: 20,
      // Keep the production stability window: a provisional first-poll grace
      // must not reset failure history. Explicit transport failures bypass dwell.
      routeCooldownMs: 1_000,
      switchWindowMs: 5_000,
      maxSwitchesInWindow: 4,
      ...policyOverrides,
    },
  });
  await controller.initialize();
  return {
    controller,
    spawnedRoutes,
    environments,
    maximumActiveProcesses: () => maximumActiveProcesses,
  };
}

async function startRoutedController(
  harness: RoutingHarness,
  options: {
    readonly directFallback?: boolean;
    readonly autoReconnect?: boolean;
  } = {},
): Promise<void> {
  await harness.controller.configureSecureTunnel({
    tunnelId: validTunnelId,
    runtimeApiKey: "runtime-key-for-route-coordinator-test",
    controlPlaneProxyUrl: primaryProxyUrl,
    controlPlaneBackupProxyUrl: backupProxyUrl,
    controlPlaneDirectFallbackEnabled: options.directFallback ?? false,
  });
  await harness.controller.setSecureTunnelAutomation({
    autoStart: false,
    autoReconnect: options.autoReconnect ?? true,
  });
  await harness.controller.start();
  await harness.controller.startSecureTunnel();
}

afterEach(async () => {
  if (originalTunnelClientPath === undefined) {
    delete process.env.SCR_TUNNEL_CLIENT_PATH;
  } else {
    process.env.SCR_TUNNEL_CLIENT_PATH = originalTunnelClientPath;
  }
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })),
  );
});

describe("classified control-plane route coordinator", () => {
  it("switches from primary to backup only after two confirmed transport failures", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "primary" ? transportFailureScript : readyConnectorScript
    );
    try {
      await startRoutedController(harness);
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.phase === "ready" &&
          candidate.secureTunnel.controlPlaneRouting.activeRoute === "backup",
      );
      expect(harness.spawnedRoutes).toEqual(["primary", "primary", "backup"]);
      expect(harness.maximumActiveProcesses()).toBe(1);
      expect(state.phase).toBe("running");
      expect(state.secureTunnel.controlPlaneRouting).toMatchObject({
        enabled: true,
        lifecycle: "running",
        activeRoute: "backup",
        switchCount: 1,
      });
      expect(state.secureTunnel.controlPlaneRouting.routes.primary.status)
        .toBe("cooling-down");
      expect(state.secureTunnel.controlPlaneRouting.routes.backup.status).toBe("ready");
      for (const environment of harness.environments) {
        expect(environment.NO_PROXY).toBe("127.0.0.1,localhost,::1");
        expect(environment.MCP_SERVER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      }
      expect(harness.environments[2]?.SCR_TUNNEL_CONTROL_PLANE_PROXY_URL)
        .toBe(new URL(backupProxyUrl).toString());
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("stops for authorization failure without trying backup", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "primary" ? authorizationFailureScript : readyConnectorScript
    );
    try {
      await startRoutedController(harness);
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.controlPlaneRouting.lifecycle === "needs-attention",
      );
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      expect(state.phase).toBe("running");
      expect(state.secureTunnel.phase).toBe("error");
      expect(state.secureTunnel.nextReconnectAt).toBeNull();
      expect(state.secureTunnel.desiredRunning).toBe(false);
      expect(state.secureTunnel.failureDiagnostic).toMatchObject({
        failureClass: "auth",
        routeSwitchEligible: false,
      });
      expect(state.secureTunnel.controlPlaneRouting.activeRoute).toBe("primary");
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("reports the current route failure instead of a previous route failure", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "primary" ? transportFailureScript : authorizationFailureScript
    );
    try {
      await startRoutedController(harness);
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.controlPlaneRouting.lifecycle === "needs-attention" &&
          candidate.secureTunnel.controlPlaneRouting.activeRoute === "backup",
      );
      expect(harness.spawnedRoutes).toEqual(["primary", "primary", "backup"]);
      expect(state.secureTunnel.failureDiagnostic).toMatchObject({
        failureClass: "auth",
        routeSwitchEligible: false,
      });
      expect(state.secureTunnel.controlPlaneRouting.routes.primary.status)
        .toBe("cooling-down");
      expect(state.secureTunnel.controlPlaneRouting.routes.backup.status).toBe("failed");
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("treats local MCP readiness failure as non-routable", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "primary" ? localMcpFailureScript : readyConnectorScript
    );
    try {
      await startRoutedController(harness);
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.controlPlaneRouting.lifecycle === "needs-attention",
      );
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      expect(state.secureTunnel.failureDiagnostic).toMatchObject({
        failureClass: "local-mcp",
        source: "readyz",
        routeSwitchEligible: false,
      });
      expect(state.secureTunnel.controlPlaneRouting.routes.backup.status).toBe("untested");
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("cancels a pending same-route retry when Stop is requested", async () => {
    const harness = await createRoutingHarness(
      () => transportFailureScript,
      { sameRouteRetryDelayMs: 300 },
    );
    try {
      await startRoutedController(harness);
      await waitForState(
        harness.controller,
        (candidate) => candidate.secureTunnel.nextReconnectAt !== null,
      );
      const stopped = await harness.controller.stopSecureTunnel();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 380));
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      expect(stopped.secureTunnel.desiredRunning).toBe(false);
      expect(stopped.secureTunnel.nextReconnectAt).toBeNull();
      expect(stopped.secureTunnel.controlPlaneRouting).toMatchObject({
        lifecycle: "stopped",
        activeRoute: null,
      });
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("tries another route only after an unclassified startup exceeds its deadline", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "primary" ? genericNotReadyScript : readyConnectorScript,
      {}, { controlPlanePollDeadlineMs: 1_000 },
    );
    try {
      await startRoutedController(harness);
      await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.failureDiagnostic?.failureClass === "unknown",
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const state = harness.controller.state();
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      expect(state.secureTunnel.controlPlaneRouting).toMatchObject({
        lifecycle: "running",
        activeRoute: "primary",
      });
      expect(state.secureTunnel.controlPlaneRouting.routes.backup.status).toBe("untested");
      await waitForState(harness.controller, candidate => candidate.secureTunnel.phase === "ready" &&
        candidate.secureTunnel.controlPlaneRouting.activeRoute === "backup");
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("uses explicit direct fallback only after primary and backup transport failure", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "direct" ? readyConnectorScript : transportFailureScript
    );
    try {
      await startRoutedController(harness, { directFallback: true });
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.phase === "ready" &&
          candidate.secureTunnel.controlPlaneRouting.activeRoute === "direct",
        15_000,
      );
      expect(harness.spawnedRoutes).toEqual([
        "primary",
        "primary",
        "backup",
        "backup",
        "direct",
      ]);
      expect(state.secureTunnel.controlPlaneRouting.switchCount).toBe(2);
      expect(state.secureTunnel.controlPlaneRouting.routes.direct).toMatchObject({
        configured: true,
        status: "ready",
      });
      expect(harness.environments.at(-1)?.SCR_TUNNEL_CONTROL_PLANE_PROXY_URL)
        .toBeUndefined();
    } finally {
      await harness.controller.shutdown();
    }
  }, 30_000);

  it("keeps a healthy connector whose first long poll is still open", async () => {
    // Treating "no completed poll yet" as a failure recycled every healthy
    // connector on start and left the tunnel down after an update.
    // The first poll completes after the startup grace and many probes, but
    // well inside the deadline, as a real 30s long poll does against 75s.
    const harness = await createRoutingHarness(() => slowFirstPollConnectorScript, {}, {
      controlPlanePollDeadlineMs: 15_000,
    });
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, candidate => candidate.secureTunnel.healthUrl !== null);
      const pending = await harness.controller.refreshSecureTunnel();
      expect(pending.secureTunnel.phase).toBe("starting");
      expect(pending.secureTunnel.lastReadyAt).toBeNull();
      expect(pending.secureTunnel.failureDiagnostic).toBeNull();
      await writeFile(`${harness.environments[0]!.HEALTH_URL_FILE}.poll-completed`, "completed");
      await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.phase === "ready" &&
          candidate.secureTunnel.controlPlaneRouting.activeRoute === "primary",
        15_000,
      );
      // Well past the first poll: still the one connector that was started.
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      const state = harness.controller.state();
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      expect(state.secureTunnel.phase).toBe("ready");
      expect(state.secureTunnel.failureDiagnostic).toBeNull();
    } finally {
      await harness.controller.shutdown();
    }
  }, 30_000);

  it("does not settle on a route that is locally ready but never reaches the control plane", async () => {
    // The overnight incident: the proxy went away, failover landed on a direct
    // route that DNS poisoning made unreachable, and /readyz kept answering 200
    // there, so the tunnel reported ready while no request could arrive.
    let primaryRecovered = false;
    const harness = await createRoutingHarness((route) =>
      route === "direct"
        ? readyWithoutControlPlaneScript
        : route === "primary" && primaryRecovered
          ? readyConnectorScript
          : transportFailureScript
    );
    try {
      await startRoutedController(harness, { directFallback: true });
      const parked = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.controlPlaneRouting.lifecycle === "circuit-open",
        15_000,
      );
      expect(harness.spawnedRoutes).toContain("direct");
      // Recorded as a failed route rather than left looking healthy or untried.
      expect(["cooling-down", "failed"]).toContain(parked.secureTunnel.controlPlaneRouting.routes.direct.status);

      // The proxy comes back. Recovery goes to the primary route, not the
      // silent direct one.
      primaryRecovered = true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
      await harness.controller.refreshSecureTunnel();
      const recovered = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.phase === "ready" &&
          candidate.secureTunnel.controlPlaneRouting.activeRoute === "primary",
        15_000,
      );
      expect(recovered.secureTunnel.controlPlaneRouting.routes.primary.status).toBe("ready");
    } finally {
      await harness.controller.shutdown();
    }
  }, 40_000);

  it("opens only the remote-route circuit when all configured routes fail", async () => {
    const harness = await createRoutingHarness(() => transportFailureScript);
    try {
      await startRoutedController(harness);
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.controlPlaneRouting.lifecycle === "circuit-open" &&
          candidate.secureTunnel.processId === null,
      );
      expect(harness.spawnedRoutes).toEqual([
        "primary",
        "primary",
        "backup",
        "backup",
      ]);
      expect(state.phase).toBe("running");
      expect(state.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      expect(state.secureTunnel.phase).toBe("error");
      expect(state.secureTunnel.processId).toBeNull();
      expect(state.secureTunnel.desiredRunning).toBe(true);
      expect(state.secureTunnel.controlPlaneRouting.circuitReason).toMatch(/No alternate/u);
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("does not retry or switch when automatic reconnect is disabled", async () => {
    const harness = await createRoutingHarness((route) =>
      route === "primary" ? transportFailureScript : readyConnectorScript
    );
    try {
      await startRoutedController(harness, { autoReconnect: false });
      const state = await waitForState(
        harness.controller,
        (candidate) =>
          candidate.secureTunnel.controlPlaneRouting.lifecycle === "needs-attention",
      );
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      expect(state.secureTunnel.desiredRunning).toBe(false);
      expect(state.secureTunnel.nextReconnectAt).toBeNull();
      expect(state.secureTunnel.controlPlaneRouting.activeRoute).toBe("primary");
      await harness.controller.refreshSecureTunnel({ networkChanged: true });
      expect(harness.spawnedRoutes).toEqual(["primary"]);
    } finally {
      await harness.controller.shutdown();
    }
  });

  it("automatically resumes after all routes fail and still honors Stop", async () => {
    let available = false;
    const harness = await createRoutingHarness(() => available ? readyConnectorScript : transportFailureScript);
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, state => state.secureTunnel.controlPlaneRouting.lifecycle === "circuit-open" && state.secureTunnel.processId === null);
      available = true;
      const before = harness.spawnedRoutes.length;
      await harness.controller.refreshSecureTunnel();
      expect(harness.spawnedRoutes).toHaveLength(before);
      await new Promise(resolve => setTimeout(resolve, 1050));
      await harness.controller.refreshSecureTunnel();
      const recovered = await waitForState(harness.controller, state => state.secureTunnel.phase === "ready");
      expect(recovered.secureTunnel.controlPlaneRouting.switchCount).toBe(2);
      expect(harness.spawnedRoutes).toEqual(["primary", "primary", "backup", "backup", "primary"]);
      expect(harness.maximumActiveProcesses()).toBe(1);
      await harness.controller.stopSecureTunnel();
      await harness.controller.refreshSecureTunnel({ networkChanged: true });
      expect(harness.spawnedRoutes).toHaveLength(before + 1);
    } finally { await harness.controller.shutdown(); }
  }, 20000);

  it("rebuilds an active routed connection on network change with only one connector", async () => {
    const harness = await createRoutingHarness(() => readyConnectorScript);
    try {
      await startRoutedController(harness, { directFallback: true });
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready");
      await harness.controller.refreshSecureTunnel({ networkChanged: true });
      const recovered = await waitForState(harness.controller, state => state.secureTunnel.phase === "ready");
      expect(harness.spawnedRoutes).toEqual(["primary", "primary"]);
      expect(recovered.secureTunnel.controlPlaneRouting.switchCount).toBe(0);
      expect(harness.maximumActiveProcesses()).toBe(1);
      await harness.controller.setSecureTunnelAutomation({ autoStart: false, autoReconnect: false });
      await harness.controller.refreshSecureTunnel({ networkChanged: true });
      expect(harness.spawnedRoutes).toHaveLength(2);
    } finally { await harness.controller.shutdown(); }
  }, 15000);

  it("stays on a proxy whose connector logs failures while its polls keep completing", async () => {
    // Each of these lines used to recycle a healthy connector, cutting every
    // request in flight and ending the sessions riding on the tunnel. A route
    // that has really gone stops completing polls, which the probe catches.
    const noisyPrimary = readyConnectorScript.replace(
      "(req,res)=>{res.statusCode=200;",
      "(req,res)=>{if(req.url==='/__test/inject-log-failures'){" +
        "console.error('controlplane poll: proxyconnect tcp: dial tcp 127.0.0.1:1: connection refused');" +
        "console.error(JSON.stringify({level:'WARN',msg:'dispatcher received MCP upstream error; posted error response to control plane',component:'dispatcher',error:'Post http://127.0.0.1:1/mcp: context deadline exceeded'}));" +
        "res.statusCode=204;res.end();return;}res.statusCode=200;",
    );
    expect(noisyPrimary).not.toBe(readyConnectorScript);
    const harness = await createRoutingHarness(route => route === "primary"
      ? noisyPrimary
      : readyConnectorScript, { minimumDwellMs: 5000 });
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready" &&
        state.secureTunnel.controlPlaneRouting.activeRoute === "primary");
      const spawnCount = harness.spawnedRoutes.length;
      await signalConnectorFixture(harness, "inject-log-failures");
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      const state = harness.controller.state();
      expect(harness.spawnedRoutes).toHaveLength(spawnCount);
      expect(state.secureTunnel.phase).toBe("ready");
      expect(state.secureTunnel.controlPlaneRouting.switchCount).toBe(0);
    } finally { await harness.controller.shutdown(); }
  }, 15000);

  it("lets a failed poll supersede advisory retry logs and reach the healthy route", async () => {
    const noisy = readyWithoutControlPlaneScript.replace(
      "res.end(req.url==='/metrics'?'commands_poll_cycles_total 7':'ready');",
      "if(req.url==='/metrics'){console.error('controlplane poll failed; backing off: proxyconnect tcp: connection refused retry_in_ms=100');setTimeout(()=>res.end('commands_poll_cycles_total 7'),30);}else{res.end('ready');}",
    );
    expect(noisy).not.toBe(readyWithoutControlPlaneScript);
    const harness = await createRoutingHarness(route => route === "primary" ? noisy : readyConnectorScript);
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready" &&
        state.secureTunnel.controlPlaneRouting.activeRoute === "backup");
      expect(harness.spawnedRoutes).toEqual(["primary", "primary", "backup"]);
      expect(harness.maximumActiveProcesses()).toBe(1);
    } finally { await harness.controller.shutdown(); }
  });

  it("restarts a routed connector after prolonged local silence without restarting its gateway", async () => {
    const hangs = readyConnectorScript
      .replace("const server=http.createServer", "let hanging=false;const server=http.createServer")
      .replace(
        "(req,res)=>{res.statusCode=200;",
        "(req,res)=>{if(req.url==='/__test/hang'){hanging=true;res.statusCode=204;res.end();return;}if(hanging)return;res.statusCode=200;",
      );
    expect(hangs).not.toBe(readyConnectorScript);
    let repaired = false;
    const harness = await createRoutingHarness(route =>
      route === "primary" && !repaired ? hangs : readyConnectorScript, {}, {
      localProbeTimeoutMs: 100, controlPlanePollFreshnessMs: 1_500,
    });
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready" &&
        state.secureTunnel.controlPlaneRouting.activeRoute === "primary");
      const endpoint = harness.controller.state().endpoint;
      const spawnCount = harness.spawnedRoutes.length;
      await signalConnectorFixture(harness, "hang");
      repaired = true;
      await waitForState(harness.controller, state => harness.spawnedRoutes.length === spawnCount + 1 &&
        state.secureTunnel.phase === "ready" &&
        state.secureTunnel.controlPlaneRouting.activeRoute === "primary");
      expect(harness.spawnedRoutes).toHaveLength(spawnCount + 1);
      expect(harness.spawnedRoutes.at(-1)).toBe("primary");
      expect(harness.controller.state().endpoint).toBe(endpoint);
      expect(harness.maximumActiveProcesses()).toBe(1);
    } finally { await harness.controller.shutdown(); }
  });

  it("does not turn an automation setting refresh into a retry after authorization failed", async () => {
    const harness = await createRoutingHarness((_route, attempt) => attempt === 1 ? authorizationFailureScript : readyConnectorScript);
    try {
      await harness.controller.configureSecureTunnel({ tunnelId: validTunnelId,
        runtimeApiKey: "runtime-key-for-route-coordinator-test", controlPlaneProxyUrl: primaryProxyUrl });
      await harness.controller.setSecureTunnelAutomation({ autoStart: true, autoReconnect: true });
      await harness.controller.start();
      await harness.controller.startSecureTunnel();
      await waitForState(harness.controller, state => state.secureTunnel.failureDiagnostic?.failureClass === "auth");
      await harness.controller.setSecureTunnelAutomation({ autoStart: true, autoReconnect: true });
      expect(harness.spawnedRoutes).toEqual(["primary"]);
      await harness.controller.startSecureTunnel();
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready");
      expect(harness.spawnedRoutes).toEqual(["primary", "primary"]);
    } finally { await harness.controller.shutdown(); }
  });

  it("recovers when a previously ready connector keeps returning generic 503 responses", async () => {
    const losesReadiness = readyConnectorScript
      .replace("const server=http.createServer", "let notReady=false;const server=http.createServer")
      .replace(
        "(req,res)=>{res.statusCode=200;",
        "(req,res)=>{if(req.url==='/__test/not-ready'){notReady=true;res.statusCode=204;res.end();return;}" +
          "if(notReady){res.statusCode=503;res.end('temporarily unavailable');return;}res.statusCode=200;",
      );
    expect(losesReadiness).not.toBe(readyConnectorScript);
    let repaired = false;
    const harness = await createRoutingHarness(route =>
      route === "primary" && !repaired ? losesReadiness : readyConnectorScript,
      { routeCooldownMs: 250 });
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready" &&
        state.secureTunnel.controlPlaneRouting.activeRoute === "primary");
      const endpoint = harness.controller.state().endpoint;
      const spawnCount = harness.spawnedRoutes.length;
      await signalConnectorFixture(harness, "not-ready");
      repaired = true;
      await waitForState(harness.controller, state =>
        state.secureTunnel.controlPlaneRouting.lifecycle === "needs-attention" ||
        harness.spawnedRoutes.length > spawnCount);
      if (harness.spawnedRoutes.length === spawnCount) {
        await new Promise(resolve => setTimeout(resolve, 300));
        await harness.controller.refreshSecureTunnel();
      }
      await waitForState(harness.controller, state => harness.spawnedRoutes.length === spawnCount + 1 &&
        state.secureTunnel.phase === "ready" &&
        state.secureTunnel.controlPlaneRouting.activeRoute === "primary", 10_000);
      expect(harness.spawnedRoutes).toHaveLength(spawnCount + 1);
      expect(harness.spawnedRoutes.at(-1)).toBe("primary");
      expect(harness.controller.state().endpoint).toBe(endpoint);
      expect(harness.maximumActiveProcesses()).toBe(1);
    } finally { await harness.controller.shutdown(); }
  });

  it("recovers after a network notification arrives during attention cooldown and still honors Stop", async () => {
    let repaired = false;
    const harness = await createRoutingHarness(() => repaired ? readyConnectorScript : localMcpFailureScript,
      { routeSwitchDelayMs: 500, routeCooldownMs: 1_000 });
    try {
      await startRoutedController(harness);
      await waitForState(harness.controller, state => state.secureTunnel.controlPlaneRouting.lifecycle === "needs-attention");
      repaired = true;
      await harness.controller.refreshSecureTunnel({ networkChanged: true });
      await new Promise(resolve => setTimeout(resolve, 1_050));
      await harness.controller.refreshSecureTunnel();
      await waitForState(harness.controller, state => state.secureTunnel.phase === "ready");
      const count = harness.spawnedRoutes.length;
      await harness.controller.stopSecureTunnel();
      await harness.controller.refreshSecureTunnel({ networkChanged: true });
      expect(harness.spawnedRoutes).toHaveLength(count);
      expect(harness.controller.state().secureTunnel.desiredRunning).toBe(false);
    } finally { await harness.controller.shutdown(); }
  });
});
