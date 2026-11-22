import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshRegisteredGeminiConnection,
  startGatewayRuntime,
  type GatewayRuntimeHandle,
} from "@sovereign/gateway/runtime";

import { ControlPlaneController, type ControlPlaneControllerOptions } from "../src/controller.js";
import { SecureMcpTunnelController } from "../src/secure-tunnel.js";
import { GeminiConnectionManager } from "../src/gemini-connection.js";
import { DEFAULT_CONTROL_PLANE_SETTINGS, writeControlPlaneSettings } from "../src/settings.js";

vi.mock("@sovereign/gateway/runtime", () => ({
  RUNTIME_VERSION: "0.1.6",
  startGatewayRuntime: vi.fn(),
  refreshRegisteredGeminiConnection: vi.fn(),
}));

const roots: string[] = [];
const controllers: ControlPlaneController[] = [];

beforeEach(() => {
  let sequence = 0;
  vi.mocked(startGatewayRuntime).mockReset().mockImplementation(async () => ({
    endpoint: `http://127.0.0.1:${42000 + ++sequence}/mcp`,
    manifest: { digest: "fixture-manifest", tools: [] },
    sessionCount: () => 0,
    stop: vi.fn(async () => {}),
  }) as unknown as GatewayRuntimeHandle);
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  expect(refreshRegisteredGeminiConnection).not.toHaveBeenCalled();
});

async function fixture(options: {
  publish?: ControlPlaneControllerOptions["onAuthoritativeGatewayConnection"];
  passive?: boolean;
  autoStart?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "scr-connection-owner-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeControlPlaneSettings(join(root, "settings.json"), {
    ...DEFAULT_CONTROL_PLANE_SETTINGS,
    workspaceRoot,
    autoStart: options.autoStart ?? false,
  });
  let tunnel!: SecureMcpTunnelController;
  const controller = new ControlPlaneController({
    userDataPath: root,
    nativeAgentPath: join(root, "unused-native-agent.exe"),
    gatewayBearerToken: "A".repeat(43),
    passiveCutoverCandidate: options.passive ?? false,
    ...(options.publish === undefined ? {} : { onAuthoritativeGatewayConnection: options.publish }),
    shell: {
      chooseWorkspace: async () => null,
      chooseSecureTunnelExecutable: async () => null,
      protectSecret: async () => null,
      restoreSecret: async () => null,
      prompt: async () => 0,
    },
    approvalSurface: { present: async () => "deny" },
    secureTunnelFactory: (settings) => {
      tunnel = new SecureMcpTunnelController(settings);
      return tunnel;
    },
  });
  controllers.push(controller);
  await controller.initialize();
  return { controller, tunnel };
}

describe("authoritative Gateway connection publication", () => {
  it("keeps ordinary controllers free of user-pairing side effects by default", async () => {
    const { controller } = await fixture();
    await controller.start();
    await controller.stop();
    await controller.start();
    expect(controller.state().phase).toBe("running");
    expect(startGatewayRuntime).toHaveBeenCalledTimes(2);
  });

  it("publishes each successful active start and credential rotation without republishing an unchanged start", async () => {
    const publish = vi.fn(async (_endpoint: string, _token: string) => {});
    const { controller } = await fixture({ publish, autoStart: true });
    await controller.start();
    const firstEndpoint = controller.state().endpoint;
    expect(publish).toHaveBeenLastCalledWith(firstEndpoint, "A".repeat(43));
    await controller.start();
    expect(publish).toHaveBeenCalledTimes(1);

    await controller.stop();
    await controller.start();
    expect(publish).toHaveBeenLastCalledWith(controller.state().endpoint, "A".repeat(43));
    await controller.rotateCredentials();
    const rotatedToken = vi.mocked(startGatewayRuntime).mock.calls.at(-1)![0].bearerToken;
    expect(rotatedToken).not.toBe("A".repeat(43));
    expect(publish).toHaveBeenLastCalledWith(controller.state().endpoint, rotatedToken);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("keeps a warmed candidate private and publishes once after a successful promotion", async () => {
    const publish = vi.fn(async (_endpoint: string, _token: string) => {});
    const { controller } = await fixture({ publish, passive: true });
    expect(controller.state().phase).toBe("running");
    expect(publish).not.toHaveBeenCalled();
    await controller.promoteCutoverCandidate("checkpoint-1", false);
    expect(publish).toHaveBeenCalledExactlyOnceWith(controller.state().endpoint, "A".repeat(43));
    await controller.promoteCutoverCandidate("checkpoint-1", false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not publish a candidate when a later promotion step throws", async () => {
    const publish = vi.fn(async (_endpoint: string, _token: string) => {});
    const { controller, tunnel } = await fixture({ publish, passive: true });
    await controller.stop();
    const stoppedTunnel = tunnel.state();
    vi.spyOn(tunnel, "state")
      .mockReturnValueOnce(stoppedTunnel)
      .mockImplementationOnce(() => {
        expect(publish).not.toHaveBeenCalled();
        throw new Error("fixture route failed");
      });
    await expect(controller.promoteCutoverCandidate("checkpoint-1", true)).rejects.toThrow("fixture route failed");
    expect(publish).not.toHaveBeenCalled();
    await controller.promoteCutoverCandidate("checkpoint-1", false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("restores the previous owner's pairing after candidate rollback even without a tunnel", async () => {
    const publish = vi.fn(async (_endpoint: string, _token: string) => {});
    const { controller: previous } = await fixture({ publish });
    const { controller: candidate } = await fixture({ publish, passive: true });
    await previous.start();
    const previousEndpoint = previous.state().endpoint;
    await previous.detachExternalTrafficForCutover("checkpoint-1");
    await candidate.promoteCutoverCandidate("checkpoint-1", false);
    expect(publish).toHaveBeenLastCalledWith(candidate.state().endpoint, "A".repeat(43));
    await candidate.stop();
    await previous.resumeExternalTrafficAfterCutover("checkpoint-1", false);
    expect(publish).toHaveBeenLastCalledWith(previousEndpoint, "A".repeat(43));
    expect(publish).toHaveBeenCalledTimes(3);
    await expect(previous.resumeExternalTrafficAfterCutover("wrong-checkpoint", false)).rejects.toThrow();
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("keeps the owner running and emits only a fixed warning when publication fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const publish = vi.fn(async () => { throw new Error("fixture-secret-must-not-be-logged"); });
    const { controller } = await fixture({ publish });
    await controller.start();
    expect(controller.state().phase).toBe("running");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "The existing Gemini local pairing could not follow the current Gateway connection.",
    );
  });

  it("keeps Gemini restoration separate from the ChatGPT route across promote and rollback", async () => {
    const restore = vi.spyOn(GeminiConnectionManager.prototype, "restore");
    const suspend = vi.spyOn(GeminiConnectionManager.prototype, "suspend");
    const publish = vi.fn(async () => {});
    const { controller: previous } = await fixture({ publish, autoStart: true });
    expect(restore).toHaveBeenCalledTimes(1);
    const previousManager = restore.mock.contexts[0];

    const { controller: candidate } = await fixture({ publish, passive: true });
    expect(restore).toHaveBeenCalledTimes(1);
    await previous.detachExternalTrafficForCutover("gemini-checkpoint");
    expect(suspend.mock.contexts.at(-1)).toBe(previousManager);

    await candidate.promoteCutoverCandidate("gemini-checkpoint", false);
    expect(restore).toHaveBeenCalledTimes(2);
    const candidateManager = restore.mock.contexts[1];
    expect(candidateManager).not.toBe(previousManager);
    await candidate.stop();
    expect(suspend.mock.contexts.at(-1)).toBe(candidateManager);

    await previous.resumeExternalTrafficAfterCutover("gemini-checkpoint", false);
    expect(restore).toHaveBeenCalledTimes(3);
    expect(restore.mock.contexts.at(-1)).toBe(previousManager);
    await previous.stop();
    expect(suspend.mock.contexts.at(-1)).toBe(previousManager);
  });

  it("permits passive status reads but denies manual Gemini mutations and isolated auto-restore", async () => {
    const restore = vi.spyOn(GeminiConnectionManager.prototype, "restore");
    const { controller: passive } = await fixture({ passive: true });
    expect((await passive.getGeminiConnection()).phase).toBe("unconfigured");
    await expect(passive.startGeminiConnection()).rejects.toThrow("Only the active Runtime Host");
    await expect(passive.stopGeminiConnection()).rejects.toThrow("Only the active Runtime Host");
    const { controller: isolated } = await fixture({ autoStart: true });
    expect(isolated.state().phase).toBe("running");
    expect(restore).not.toHaveBeenCalled();
  });

});
