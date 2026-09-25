import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SecureMcpTunnelController } from "../../apps/desktop/src/secure-tunnel.js";
import { ControlPlaneController } from "../../packages/control-plane/src/controller.js";

const validTunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const cleanupPaths: string[] = [];
const originalTunnelClientPath = process.env.SCR_TUNNEL_CLIENT_PATH;

afterEach(async () => {
  if (originalTunnelClientPath === undefined) {
    delete process.env.SCR_TUNNEL_CLIENT_PATH;
  } else {
    process.env.SCR_TUNNEL_CLIENT_PATH = originalTunnelClientPath;
  }
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Secure MCP Tunnel desktop controller", () => {
  it("gives a replacement connector its own startup grace after an earlier generation was ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-replacement-grace-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let launches = 0;
    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "health.txt"),
      startupReadyTimeoutMs: 40,
      healthProbeIntervalMs: 20,
      controlPlanePollDeadlineMs: 3_000,
      reconnectDelaysMs: [20],
      spawnConnector: (_executable, _args, options) => {
        launches += 1;
        const source = [
          "const http=require('node:http'),fs=require('node:fs'),started=Date.now();",
          `const warming=${launches > 1};`,
          "const server=http.createServer((req,res)=>{",
          "if(warming&&Date.now()-started<700){res.statusCode=503;res.end('warming up');return;}",
          "res.end(req.url==='/metrics'?'commands_poll_last_successful_timestamp_seconds '+Date.now()/1000:'ready');});",
          "server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.HEALTH_URL_FILE,'http://127.0.0.1:'+server.address().port));",
        ].join("");
        return spawn(process.execPath, ["-e", source], options);
      },
      terminateConnector: async (child) => { child.kill(); },
    });
    controller.configure({ tunnelId: validTunnelId, runtimeApiKey: "runtime-key-for-startup-grace-test" });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);
    try {
      await controller.start({ gatewayEndpoint: "http://127.0.0.1:3210/mcp", gatewayBearerToken: "gateway-token-for-startup-grace-test" });
      await vi.waitFor(() => expect(controller.state().phase).toBe("ready"), { timeout: 3_000 });
      await controller.refresh({ networkChanged: true });
      await vi.waitFor(() => expect(controller.state().phase).toBe("ready"), { timeout: 3_000 });
      expect(launches).toBe(2);
    } finally {
      await controller.shutdown();
    }
  });

  it.each([
    ["auth", "control-plane poll returned 403 forbidden", false],
    ["auth", "control-plane poll returned 403 forbidden", true],
    ["identity", "invalid tunnel id", false],
    ["identity", "invalid tunnel id", true],
  ] as const)("requires explicit Start after %s: %s (connector exits: %s)", async (failureClass, message, exits) => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-hard-failure-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    let launches = 0;
    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "health.txt"),
      startupReadyTimeoutMs: 40,
      healthProbeIntervalMs: 20,
      reconnectDelaysMs: [20],
      spawnConnector: (_executable, _args, options) => {
        launches += 1;
        return spawn(process.execPath, ["-e", `console.error(${JSON.stringify(message)});` +
          (exits ? "setTimeout(()=>process.exit(7),30);" : "setInterval(()=>{},1000);")], options);
      },
      terminateConnector: async (child) => { child.kill(); },
    });
    controller.configure({ tunnelId: validTunnelId, runtimeApiKey: "runtime-key-for-hard-failure-test" });
    controller.trustCurrentExecutable();
    controller.setAutoReconnect(true);
    const options = { gatewayEndpoint: "http://127.0.0.1:3210/mcp", gatewayBearerToken: "gateway-token-for-hard-failure-test" };
    try {
      await controller.start(options);
      await vi.waitFor(() => expect(controller.state().failureDiagnostic?.failureClass).toBe(failureClass));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await controller.refresh();
      await controller.refresh({ networkChanged: true });
      controller.setAutoReconnect(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(launches).toBe(1);
      expect(controller.state().nextReconnectAt).toBeNull();
      await controller.start(options);
      expect(launches).toBe(2);
      await controller.stop();
      await controller.refresh({ networkChanged: true });
      expect(launches).toBe(2);
      expect(controller.state().desiredRunning).toBe(false);
    } finally {
      await controller.shutdown();
    }
  });

  it("rejects malformed tunnel identifiers before starting a child process", () => {
    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(tmpdir(), "scr-tunnel-invalid-health.txt"),
    });

    expect(() => controller.configure({ tunnelId: "tunnel_bad" })).toThrow(/tunnel_/i);
  });

  it("keeps the runtime API key opaque and clearable in memory", () => {
    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(tmpdir(), "scr-tunnel-memory-health.txt"),
    });

    const configured = controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "runtime-key-for-local-test-only",
    });
    expect(configured.tunnelId).toBe(validTunnelId);
    expect(configured.hasRuntimeApiKey).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("runtime-key-for-local-test-only");

    const cleared = controller.configure({
      tunnelId: validTunnelId,
      clearRuntimeApiKey: true,
    });
    expect(cleared.hasRuntimeApiKey).toBe(false);
  });

  it("keeps a replacement runtime key memory-only when Windows protection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-memory-only-"));
    cleanupPaths.push(root);
    const plaintextKey = "runtime-key-that-must-never-be-persisted";
    const plaintextProxy = "http://proxy-user:proxy-secret@proxy.example.test:8080";
    const plaintextBackupProxy =
      "https://backup-user:backup-secret@backup-proxy.example.test:8443";
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async () => null,
        restoreSecret: async () => null,
        prompt: async () => 1,
      },
      approvalSurface: {
        present: async () => "deny",
      },
    });

    await controller.initialize();
    const configured = await controller.configureSecureTunnel({
      tunnelId: validTunnelId,
      runtimeApiKey: plaintextKey,
      controlPlaneProxyUrl: plaintextProxy,
      controlPlaneBackupProxyUrl: plaintextBackupProxy,
      controlPlaneDirectFallbackEnabled: true,
    });

    expect(configured.secureTunnel.hasRuntimeApiKey).toBe(true);
    expect(configured.secureTunnel.runtimeApiKeyStorage).toBe("memory-only");
    expect(configured.secureTunnel.controlPlaneProxyConfigured).toBe(true);
    expect(configured.secureTunnel.controlPlaneProxyDisplay).toBe("http://proxy.example.test:8080");
    expect(configured.secureTunnel.controlPlaneProxyStorage).toBe("memory-only");
    expect(configured.secureTunnel.controlPlaneBackupProxyConfigured).toBe(true);
    expect(configured.secureTunnel.controlPlaneBackupProxyDisplay).toBe(
      "https://backup-proxy.example.test:8443",
    );
    expect(configured.secureTunnel.controlPlaneBackupProxyStorage).toBe("memory-only");
    expect(configured.secureTunnel.controlPlaneDirectFallbackEnabled).toBe(true);
    const settingsText = await readFile(join(root, "settings.json"), "utf8");
    const settings = JSON.parse(settingsText) as Record<string, unknown>;
    expect(settings.secureTunnelRuntimeKeyEncrypted).toBeNull();
    expect(settings.secureTunnelControlPlaneProxyEncrypted).toBeNull();
    expect(settings.secureTunnelControlPlaneBackupProxyEncrypted).toBeNull();
    expect(settings.secureTunnelControlPlaneDirectFallback).toBe(true);
    expect(settingsText).not.toContain(plaintextKey);
    expect(settingsText).not.toContain(plaintextProxy);
    expect(settingsText).not.toContain(plaintextBackupProxy);
    expect(settingsText).not.toContain("proxy-secret");
    expect(settingsText).not.toContain("backup-secret");

    await controller.shutdown();
  });

  it("restores protected primary and backup proxies without persisting plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-protected-routes-"));
    cleanupPaths.push(root);
    const valuesByCiphertext = new Map<string, string>();
    let ciphertextSequence = 0;
    const shell = {
      chooseWorkspace: async () => null,
      chooseSecureTunnelExecutable: async () => null,
      protectSecret: async (value: string) => {
        ciphertextSequence += 1;
        const encoded = `protected-${ciphertextSequence}`;
        valuesByCiphertext.set(encoded, value);
        return encoded;
      },
      restoreSecret: async (encoded: string) => {
        const value = valuesByCiphertext.get(encoded);
        return value === undefined ? null : { value, encoded };
      },
      prompt: async () => 1,
    };
    const approvalSurface = { present: async () => "deny" as const };
    const primary = "http://primary-user:primary-secret@primary.example.test:8080";
    const backup = "https://backup-user:backup-secret@backup.example.test:8443";
    const first = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell,
      approvalSurface,
    });
    await first.initialize();
    await first.configureSecureTunnel({
      tunnelId: validTunnelId,
      runtimeApiKey: "runtime-key-for-protected-route-test",
      controlPlaneProxyUrl: primary,
      controlPlaneBackupProxyUrl: backup,
      controlPlaneDirectFallbackEnabled: true,
    });
    await first.shutdown();

    const settingsText = await readFile(join(root, "settings.json"), "utf8");
    expect(settingsText).not.toContain(primary);
    expect(settingsText).not.toContain(backup);
    expect(settingsText).not.toContain("primary-secret");
    expect(settingsText).not.toContain("backup-secret");

    const restored = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell,
      approvalSurface,
    });
    await restored.initialize();
    const state = restored.state().secureTunnel;
    expect(state.controlPlaneProxyDisplay).toBe("http://primary.example.test:8080");
    expect(state.controlPlaneProxyStorage).toBe("windows-protected");
    expect(state.controlPlaneBackupProxyDisplay).toBe("https://backup.example.test:8443");
    expect(state.controlPlaneBackupProxyStorage).toBe("windows-protected");
    expect(state.controlPlaneDirectFallbackEnabled).toBe(true);
    await restored.shutdown();
  });

  it("drops a restored backup route that resolves to the primary endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-restored-duplicate-route-"));
    cleanupPaths.push(root);
    const valuesByCiphertext = new Map<string, string>([
      ["protected-primary", "http://first-user:first-pass@proxy.example.test:8080"],
      ["protected-backup", "http://second-user:second-pass@PROXY.example.test:8080/"],
    ]);
    await writeFile(join(root, "settings.json"), JSON.stringify({
      secureTunnelId: validTunnelId,
      secureTunnelControlPlaneProxyEncrypted: "protected-primary",
      secureTunnelControlPlaneBackupProxyEncrypted: "protected-backup",
      secureTunnelControlPlaneDirectFallback: true,
      secureTunnelAutoStart: false,
      secureTunnelAutoReconnect: true,
    }), "utf8");
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async () => null,
        restoreSecret: async (encoded: string) => {
          const value = valuesByCiphertext.get(encoded);
          return value === undefined ? null : { value, encoded };
        },
        prompt: async () => 1,
      },
      approvalSurface: {
        present: async () => "deny",
      },
    });

    await controller.initialize();
    const state = controller.state().secureTunnel;
    expect(state.controlPlaneProxyConfigured).toBe(true);
    expect(state.controlPlaneBackupProxyConfigured).toBe(false);
    expect(state.controlPlaneDirectFallbackEnabled).toBe(true);
    expect(state.controlPlaneRouting.routeOrder).toEqual(["primary", "direct"]);
    const settings = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings.secureTunnelControlPlaneBackupProxyEncrypted).toBeNull();
    await controller.shutdown();
  });

  it("requires a primary proxy before backup or direct fallback configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-route-validation-"));
    cleanupPaths.push(root);
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async () => null,
        restoreSecret: async () => null,
        prompt: async () => 1,
      },
      approvalSurface: {
        present: async () => "deny",
      },
    });
    await controller.initialize();

    await expect(controller.configureSecureTunnel({
      tunnelId: validTunnelId,
      controlPlaneBackupProxyUrl: "http://backup.example.test:8080",
    })).rejects.toThrow(/primary control-plane proxy/i);
    await expect(controller.configureSecureTunnel({
      tunnelId: validTunnelId,
      controlPlaneDirectFallbackEnabled: true,
    })).rejects.toThrow(/direct fallback requires/i);
    await controller.shutdown();
  });

  it("rejects a backup proxy that resolves to the same protocol host and port", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-duplicate-route-"));
    cleanupPaths.push(root);
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async () => null,
        restoreSecret: async () => null,
        prompt: async () => 1,
      },
      approvalSurface: {
        present: async () => "deny",
      },
    });
    await controller.initialize();
    await expect(controller.configureSecureTunnel({
      tunnelId: validTunnelId,
      controlPlaneProxyUrl: "http://first-user:first-pass@proxy.example.test:8080",
      controlPlaneBackupProxyUrl: "http://second-user:second-pass@PROXY.example.test:8080/",
    })).rejects.toThrow(/different protocol\/host\/port endpoints/i);
    await controller.shutdown();
  });

  it("clearing the primary proxy also removes backup and direct fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-clear-primary-"));
    cleanupPaths.push(root);
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async () => null,
        restoreSecret: async () => null,
        prompt: async () => 1,
      },
      approvalSurface: {
        present: async () => "deny",
      },
    });
    await controller.initialize();
    await controller.configureSecureTunnel({
      tunnelId: validTunnelId,
      controlPlaneProxyUrl: "http://primary.example.test:8080",
      controlPlaneBackupProxyUrl: "http://backup.example.test:8080",
      controlPlaneDirectFallbackEnabled: true,
    });

    const cleared = await controller.configureSecureTunnel({
      tunnelId: validTunnelId,
      clearControlPlaneProxy: true,
    });
    expect(cleared.secureTunnel.controlPlaneProxyConfigured).toBe(false);
    expect(cleared.secureTunnel.controlPlaneBackupProxyConfigured).toBe(false);
    expect(cleared.secureTunnel.controlPlaneDirectFallbackEnabled).toBe(false);
    expect(cleared.secureTunnel.controlPlaneRouting).toMatchObject({
      enabled: false,
      routeOrder: ["direct"],
    });
    const settings = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings.secureTunnelControlPlaneProxyEncrypted).toBeNull();
    expect(settings.secureTunnelControlPlaneBackupProxyEncrypted).toBeNull();
    expect(settings.secureTunnelControlPlaneDirectFallback).toBe(false);
    await controller.shutdown();
  });

  it("restarts an unexpectedly exited connector with bounded backoff until stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-reconnect-"));
    cleanupPaths.push(root);
    process.env.SCR_TUNNEL_CLIENT_PATH = process.execPath;
    const attempts: number[] = [];
    let controller: SecureMcpTunnelController;
    controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "health.txt"),
      reconnectDelaysMs: [20, 40],
      healthProbeIntervalMs: 20,
      startupReadyTimeoutMs: 40,
      onStateChanged: () => attempts.push(controller.state().reconnectAttempt),
    });
    controller.configure({
      tunnelId: validTunnelId,
      runtimeApiKey: "runtime-key-for-reconnect-test",
    });
    expect(controller.trustCurrentExecutable()).toMatch(/^[a-f0-9]{64}$/u);
    controller.setAutoReconnect(true);

    try {
      await controller.start({
        gatewayEndpoint: "http://127.0.0.1:3210/mcp",
        gatewayBearerToken: "gateway-token-for-reconnect-test",
      });
      const reconnectDeadline = Date.now() + 3_000;
      while (
        !attempts.some((attempt) => attempt >= 1) &&
        Date.now() < reconnectDeadline
      ) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      expect(attempts.some((attempt) => attempt >= 1)).toBe(true);
      expect(controller.state().desiredRunning).toBe(true);
    } finally {
      const stopped = await controller.stop();
      expect(stopped.desiredRunning).toBe(false);
      expect(stopped.nextReconnectAt).toBeNull();
    }
  });

  it("pins the tunnel-client digest and detects later executable replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-tunnel-trust-"));
    cleanupPaths.push(root);
    const executablePath = join(root, "tunnel-client.exe");
    await writeFile(executablePath, "trusted tunnel binary v1", "utf8");
    process.env.SCR_TUNNEL_CLIENT_PATH = executablePath;

    const controller = new SecureMcpTunnelController({
      healthUrlFile: join(root, "health.txt"),
    });
    const initial = controller.state();
    expect(initial.executablePath).toBe(executablePath);
    expect(initial.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(initial.executableTrusted).toBe(false);

    const trustedSha256 = controller.trustCurrentExecutable();
    expect(trustedSha256).toBe(initial.executableSha256);
    expect(controller.state().executableTrusted).toBe(true);

    await writeFile(executablePath, "replaced tunnel binary v2", "utf8");
    const refreshed = await controller.refresh();
    expect(refreshed.executableTrusted).toBe(false);
    expect(refreshed.phase).toBe("error");
    expect(refreshed.errorMessage).toMatch(/changed since it was trusted/i);
  });
});
