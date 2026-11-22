import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopGeminiConnectionStatus } from "@sovereign/control-plane-contract";
import { createGeminiConnectionController } from "../src/renderer/gemini-connection-controller.js";
import { EXAMPLE_GEMINI_CONFIGURATION } from "../src/renderer/gemini-configuration-import.js";
import { renderGeminiConnectionView } from "../src/renderer/view-gemini-connection.js";

// Event/field fixture only: native modal layout, focus and constraint validation
// remain covered by the isolated Electron visual harness.
class ElementFixture extends EventTarget {
  disabled = false; hidden = false; open = false; isConnected = true;
  value = ""; textContent = ""; returnValue = ""; className = ""; title = "";
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly children: ElementFixture[] = [];
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
  };
  querySelectorAll: (selector: string) => ElementFixture[] = () => [];
  querySelector(): null { return null; }
  checkValidity(): boolean { return true; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  focus(): void { (document as unknown as { activeElement: unknown }).activeElement = this; }
  showModal(): void { this.open = true; }
  close(value = ""): void {
    if (!this.open) return;
    this.open = false; this.returnValue = value;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.children.splice(0, this.children.length, ...children); }
}

const saved: DesktopGeminiConnectionStatus = {
  phase: "saved", configuration: EXAMPLE_GEMINI_CONFIGURATION,
  hasOwnerSubject: true, hasIntrospectionAuthorization: true,
  listenEndpoint: null, lastError: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function fixture() {
  const nodes = new Map<string, ElementFixture>();
  const inputs: ElementFixture[] = [];
  for (const match of renderGeminiConnectionView().matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gu)) {
    const node = new ElementFixture();
    node.value = /\bvalue="([^"]*)"/u.exec(match[2]!)?.[1] ?? "";
    const field = /data-secret-field="([^"]*)"/u.exec(match[2]!)?.[1];
    const mode = /data-secret-mode="([^"]*)"/u.exec(match[2]!)?.[1];
    if (field) node.dataset.secretField = field;
    if (mode) node.dataset.secretMode = mode;
    nodes.set("#" + match[3]!, node);
    if (match[1] === "input") inputs.push(node);
  }
  for (const selector of [".gemini-connection-card", "#gemini-primary", "#gemini-copy-url", "#gemini-status"]) nodes.set(selector, new ElementFixture());
  const node = (selector: string) => { const result = nodes.get(selector); if (!result) throw new Error("Missing fixture " + selector); return result; };
  node("#gemini-config-form").querySelectorAll = selector => selector === "input" ? inputs : [];
  node("#gemini-protected-dialog").querySelectorAll = selector => {
    const field = /data-secret-field="([^"]+)"/u.exec(selector)?.[1];
    return [...nodes.values()].filter(value => value.dataset.secretField === field);
  };
  vi.stubGlobal("HTMLElement", ElementFixture);
  vi.stubGlobal("document", { activeElement: null, querySelector: (selector: string) => nodes.get(selector) ?? null, createElement: () => new ElementFixture() });
  const api = {
    getGeminiConnection: vi.fn<() => Promise<DesktopGeminiConnectionStatus>>().mockResolvedValue(saved),
    configureGeminiConnection: vi.fn<Parameters<typeof createGeminiConnectionController>[0]["api"]["configureGeminiConnection"]>().mockResolvedValue(saved),
    startGeminiConnection: vi.fn<() => Promise<DesktopGeminiConnectionStatus>>().mockResolvedValue({ ...saved, phase: "listening", listenEndpoint: "http://127.0.0.1:12345/mcp" }),
    stopGeminiConnection: vi.fn<() => Promise<DesktopGeminiConnectionStatus>>().mockResolvedValue(saved),
  };
  const notify = vi.fn(), openConfiguration = vi.fn();
  const controller = createGeminiConnectionController({ api, notify, openConfiguration, onStatusChanged: vi.fn() });
  const input = (selector: string, value: string) => { node(selector).value = value; node(selector).dispatchEvent(new Event("input")); };
  const submit = () => node("#gemini-config-form").dispatchEvent(new Event("submit", { cancelable: true }));
  return { api, controller, node, input, submit, notify, openConfiguration };
}
afterEach(() => vi.unstubAllGlobals());

describe("Gemini connection draft transactions", () => {
  it.each(["cancel", "escape"])("%s restores an applied draft; only Save writes and never starts", async mode => {
    const f = fixture(); await f.controller.refresh(); f.controller.setHostRunning(true);
    f.node("#gemini-protected-open").click();
    f.node("#gemini-replace-owner").click(); f.input("#gemini-owner-subject", " owner-fixture ");
    f.node("#gemini-protected-apply").click(); await flush();
    expect(f.api.configureGeminiConnection).not.toHaveBeenCalled();
    f.node("#gemini-protected-open").click();
    f.input("#gemini-owner-subject", "discarded-fixture"); f.node("#gemini-forget-authorization").click();
    f.submit(); expect(f.api.configureGeminiConnection).not.toHaveBeenCalled();
    if (mode === "cancel") f.node("#gemini-protected-cancel").click();
    else f.node("#gemini-protected-dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    await flush(); f.submit(); await flush();
    expect(f.api.configureGeminiConnection).toHaveBeenCalledExactlyOnceWith({ ...EXAMPLE_GEMINI_CONFIGURATION, ownerSubject: { action: "replace", value: " owner-fixture " }, introspectionAuthorization: { action: "keep" } });
    expect(f.api.startGeminiConnection).not.toHaveBeenCalled();
    expect(f.node("#gemini-owner-subject").value).toBe("");
  });

  it("preserves a failed public/protected draft across refresh and explicit retry", async () => {
    const f = fixture(); await f.controller.refresh();
    f.input("#gemini-client-id", "changed-client");
    f.node("#gemini-protected-open").click(); f.node("#gemini-forget-authorization").click();
    f.node("#gemini-protected-apply").click(); await flush();
    f.api.configureGeminiConnection.mockRejectedValueOnce(new Error("must-not-echo-fixture"));
    f.submit(); await flush(); await f.controller.refresh();
    expect(f.node("#gemini-client-id").value).toBe("changed-client");
    expect(f.node("#gemini-error").textContent).toBe("Could not save Gemini configuration.");
    expect(f.node("#gemini-authorization-state").textContent).toBe("Will be forgotten when saved");
    f.submit(); await flush();
    expect(f.api.configureGeminiConnection).toHaveBeenCalledTimes(2);
    expect(f.api.configureGeminiConnection.mock.calls[0]).toEqual(f.api.configureGeminiConnection.mock.calls[1]);
    expect(f.api.startGeminiConnection).not.toHaveBeenCalled();
  });

  it("coalesces refresh and rejects stale read results after a single in-flight save", async () => {
    const f = fixture(); await f.controller.refresh();
    const read = deferred<DesktopGeminiConnectionStatus>(), write = deferred<DesktopGeminiConnectionStatus>();
    f.api.getGeminiConnection.mockReturnValueOnce(read.promise);
    f.api.configureGeminiConnection.mockReturnValueOnce(write.promise);
    const first = f.controller.refresh(), second = f.controller.refresh();
    f.input("#gemini-client-id", "new-client"); f.submit(); f.submit();
    expect(f.api.configureGeminiConnection).toHaveBeenCalledTimes(1);
    const next = { ...saved, configuration: { ...EXAMPLE_GEMINI_CONFIGURATION, clientId: "new-client" } };
    write.resolve(next); await flush(); read.resolve(saved); await Promise.all([first, second]);
    expect(f.api.getGeminiConnection).toHaveBeenCalledTimes(2);
    expect(f.controller.status).toEqual(next);
    expect(f.node("#gemini-client-id").value).toBe("new-client");
  });

  it("routes an offline host to Advanced before the first status read", () => {
    const f = fixture(); f.node("#gemini-primary").click();
    expect(f.openConfiguration).toHaveBeenCalledExactlyOnceWith("advanced");
    expect(f.api.startGeminiConnection).not.toHaveBeenCalled();
  });

  it("does not announce listening when Start returns an unconfigured state", async () => {
    const f = fixture(); await f.controller.refresh(); f.controller.setHostRunning(true);
    f.api.startGeminiConnection.mockResolvedValueOnce({ ...saved, phase: "unconfigured", hasOwnerSubject: false, lastError: "Save the Gemini connection settings and credentials before starting." });
    f.node("#gemini-primary").click(); await flush();
    expect(f.api.startGeminiConnection).toHaveBeenCalledTimes(1);
    expect(f.notify).not.toHaveBeenCalledWith("Gemini listener started.");
    expect(f.notify).toHaveBeenCalledWith("Save the Gemini connection settings and credentials before starting.", true);
  });
});
