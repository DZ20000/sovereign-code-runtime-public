import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopGeminiConnectionConfigurationInput, DesktopGeminiConnectionStatus, SovereignDesktopApi } from "@sovereign/control-plane-contract";
import { IPC_CHANNELS } from "../src/shared.js";
import { registerGeminiConnectionIpc } from "../src/gemini-connection-ipc.js";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), invoke: vi.fn(), expose: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: mocks.expose },
}));
const status: DesktopGeminiConnectionStatus = {
  phase: "saved", configuration: null, hasOwnerSubject: true,
  hasIntrospectionAuthorization: true, listenEndpoint: null, lastError: null,
};
const input: DesktopGeminiConnectionConfigurationInput = {
  publicMcpUrl: "https://mcp.example.test/mcp",
  oauthDiscoveryUrl: "https://oauth.example.test/.well-known/openid-configuration",
  introspectionUrl: "https://oauth.example.test/introspect",
  clientId: "fixture-client", loopbackPort: 0,
  ownerSubject: { action: "replace", value: "fixture-owner" },
  introspectionAuthorization: { action: "keep" },
};
type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
const event = {} as IpcMainInvokeEvent;
function setup() {
  mocks.handle.mockClear();
  const controller = {
    getGeminiConnection: vi.fn().mockResolvedValue(status),
    configureGeminiConnection: vi.fn().mockResolvedValue(status),
    startGeminiConnection: vi.fn().mockResolvedValue(status),
    stopGeminiConnection: vi.fn().mockResolvedValue(status),
  };
  const trusted = vi.fn();
  registerGeminiConnectionIpc(controller, trusted);
  return { controller, trusted, handlers: new Map(mocks.handle.mock.calls as [string, Handler][]) };
}

describe("Gemini desktop IPC", () => {
  it.each(["getGeminiConnection", "startGeminiConnection", "stopGeminiConnection"] as const)(
    "authorizes %s before forwarding only that operation", async (method) => {
      const { controller, trusted, handlers } = setup();
      await expect(handlers.get(IPC_CHANNELS[method])!(event)).resolves.toBe(status);
      expect(trusted).toHaveBeenCalledExactlyOnceWith(event);
      expect(trusted.mock.invocationCallOrder[0]).toBeLessThan(controller[method].mock.invocationCallOrder[0]!);
      expect(controller[method]).toHaveBeenCalledExactlyOnceWith();
      expect(controller.configureGeminiConnection).not.toHaveBeenCalled();
    },
  );
  it("preserves explicit replace, keep and forget without inventing a start", async () => {
    const { controller, handlers } = setup();
    const configure = handlers.get(IPC_CHANNELS.configureGeminiConnection)!;
    await expect(configure(event, input)).resolves.toBe(status);
    expect(controller.configureGeminiConnection).toHaveBeenLastCalledWith(input);
    const forget = { ...input, ownerSubject: { action: "forget" } };
    await configure(event, forget);
    expect(controller.configureGeminiConnection).toHaveBeenLastCalledWith(forget);
    expect(controller.startGeminiConnection).not.toHaveBeenCalled();
    expect(controller.stopGeminiConnection).not.toHaveBeenCalled();
  });
  it("rejects every untrusted operation before touching the owner", async () => {
    const { controller, trusted, handlers } = setup();
    trusted.mockImplementation(() => { throw new Error("Untrusted renderer"); });
    for (const handler of handlers.values()) await expect(handler(event, input)).rejects.toThrow("Untrusted renderer");
    for (const action of Object.values(controller)) expect(action).not.toHaveBeenCalled();
  });
  it("rejects non-object configurations without dispatch", async () => {
    const { controller, handlers } = setup();
    for (const value of [null, [], "fixture", 42]) {
      await expect(handlers.get(IPC_CHANNELS.configureGeminiConnection)!(event, value)).rejects.toThrow("must be an object");
    }
    expect(controller.configureGeminiConnection).not.toHaveBeenCalled();
  });
  it("exposes the four methods through preload with no credential-bearing read", async () => {
    mocks.invoke.mockReset().mockResolvedValue(status);
    mocks.expose.mockClear();
    await import("../src/preload.js");
    const api = mocks.expose.mock.calls.find(([name]) => name === "sovereign")?.[1] as SovereignDesktopApi;
    expect(api).toBeDefined();
    await expect(api.getGeminiConnection()).resolves.toBe(status);
    await api.configureGeminiConnection(input);
    await api.startGeminiConnection();
    await api.stopGeminiConnection();
    expect(mocks.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.getGeminiConnection],
      [IPC_CHANNELS.configureGeminiConnection, input],
      [IPC_CHANNELS.startGeminiConnection],
      [IPC_CHANNELS.stopGeminiConnection],
    ]);
  });
});
