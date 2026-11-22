import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopGeminiConnectionConfigurationInput, DesktopGeminiConnectionStatus } from "@sovereign/control-plane-contract";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), window: { label: "main" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.window }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const status: DesktopGeminiConnectionStatus = {
  phase: "listening", configuration: null, hasOwnerSubject: true,
  hasIntrospectionAuthorization: true, listenEndpoint: "http://127.0.0.1:43124/mcp", lastError: null,
};
const input: DesktopGeminiConnectionConfigurationInput = {
  publicMcpUrl: "https://mcp.example.test/mcp",
  oauthDiscoveryUrl: "https://oauth.example.test/.well-known/openid-configuration",
  introspectionUrl: "https://oauth.example.test/introspect",
  clientId: "fixture-client", loopbackPort: 0,
  ownerSubject: { action: "keep" }, introspectionAuthorization: { action: "forget" },
};
beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset().mockResolvedValue(status);
  mocks.window.label = "main";
});

describe("Gemini Tauri transport", () => {
  it.each([
    ["main", "control_call"],
    ["renderer-preflight-fixture", "renderer_preflight_control_call"],
  ])("reads status through the existing %s boundary", async (label, command) => {
    mocks.window.label = label;
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    await expect(createTauriSovereignApi().getGeminiConnection()).resolves.toBe(status);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(command, { method: "gemini.connection.read", params: {} });
  });
  it("keeps configuration, start and stop separate and returns the owner's status", async () => {
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    const api = createTauriSovereignApi();
    await expect(api.configureGeminiConnection(input)).resolves.toBe(status);
    await api.startGeminiConnection();
    await api.stopGeminiConnection();
    expect(mocks.invoke.mock.calls).toEqual([
      ["control_call", { method: "gemini.connection.configure", params: { input } }],
      ["control_call", { method: "gemini.connection.start", params: {} }],
      ["control_call", { method: "gemini.connection.stop", params: {} }],
    ]);
  });
  it("routes a preflight mutation to the native read-only gate and propagates its refusal", async () => {
    mocks.window.label = "renderer-preflight-fixture";
    mocks.invoke.mockRejectedValue(new Error("Read-only preflight"));
    const { createTauriSovereignApi } = await import("../src/bridge.js");
    await expect(createTauriSovereignApi().configureGeminiConnection(input)).rejects.toThrow("Read-only preflight");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("renderer_preflight_control_call", {
      method: "gemini.connection.configure", params: { input },
    });
  });
});
