import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBrowserObservation } from "../src/shared.js";
import { BrowserController } from "../src/renderer/browser-controller.js";
import { renderBrowserView } from "../src/renderer/view-browser.js";

class ElementFixture {
  value = ""; textContent = ""; title = ""; src = ""; type = ""; className = "";
  hidden = false; disabled = false; checked = false; tabIndex = 0; focusCount = 0;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: ElementFixture[] = [];
  readonly events = new Map<string, ((event: Event) => void)[]>();
  readonly classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() };
  addEventListener(type: string, listener: (event: Event) => void): void { this.events.set(type, [...(this.events.get(type) ?? []), listener]); }
  emit(type: string, extra: Record<string, unknown> = {}): void {
    const event = { target: this, currentTarget: this, preventDefault: vi.fn(), ...extra } as unknown as Event;
    for (const listener of this.events.get(type) ?? []) listener(event);
  }
  focus(): void { this.focusCount += 1; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); if (key === "src") this.src = ""; }
  toggleAttribute(key: string, force: boolean): void { if (force) this.setAttribute(key, ""); else this.removeAttribute(key); }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.children.splice(0, this.children.length, ...children); }
  closest(selector: string): ElementFixture | null {
    return selector === "button[data-browser-ref]" && this.dataset.browserRef ? this : null;
  }
}
function fixture() {
  const nodes = new Map<string, ElementFixture>();
  for (const match of renderBrowserView().matchAll(/<[a-z]+\b([^>]*\bid="([^"]+)"[^>]*)>/gu)) {
    const element = new ElementFixture();
    element.value = /\bvalue="([^"]*)"/u.exec(match[1]!)?.[1] ?? "";
    element.checked = /\bchecked\b/u.test(match[1]!);
    nodes.set("#" + match[2]!, element);
  }
  const node = (selector: string) => { const result = nodes.get(selector); if (!result) throw new Error("Missing fixture " + selector); return result; };
  vi.stubGlobal("document", { activeElement: null, querySelector: (selector: string) => nodes.get(selector) ?? null, createElement: () => new ElementFixture() });
  vi.stubGlobal("Element", ElementFixture);
  const revision = "revision-" + "a".repeat(120);
  let observation: DesktopBrowserObservation = {
    id: "browser-fixture", state: "ready", createdAt: "2026-01-01T00:00:00Z", processId: null,
    url: "https://example.com", title: "Example page", allowedDomains: ["example.com"], blockedRequestCount: 0, error: null,
    revision, text: "Example page text", accessibility: [], screenshotBase64: "AQID", screenshotMediaType: "image/jpeg",
    elements: [{ ref: "e1", tag: "input", role: "textbox", name: "Example field", text: "", type: "text", disabled: false, editable: true, sensitive: false, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
  };
  const calls: { name: string; input: unknown }[] = [];
  const controller = new BrowserController({ notify: vi.fn(), api: {
    async invokeTool<T>(name: string, input: unknown): Promise<T> {
      calls.push({ name, input });
      if (name === "browser.capabilities") return { available: true } as T;
      if (name === "browser.session.list") return [observation] as T;
      if (name === "browser.observe" || name === "browser.click") return observation as T;
      throw new Error("Unexpected tool " + name);
    },
  } });
  controller.mount();
  return { controller, node, calls, revision, omitScreenshot() {
    const { screenshotBase64: _image, screenshotMediaType: _type, ...current } = observation;
    observation = { ...current, revision: "next-revision" };
  } };
}
afterEach(() => vi.unstubAllGlobals());

describe("browser observation presentation", () => {
  it("switches text/screenshot accessibly without changing refs or invoking a browser tool", async () => {
    const f = fixture(); await f.controller.refresh();
    f.node("#browser-element-list").emit("click", { target: f.node("#browser-element-list").children[0] });
    const callCount = f.calls.length;
    f.node("#browser-text-tab").emit("keydown", { key: "ArrowRight" });
    expect(f.node("#browser-screenshot-tab").attributes.get("aria-selected")).toBe("true");
    expect(f.node("#browser-screenshot-tab").focusCount).toBe(1);
    expect(f.node("#browser-text-panel").hidden).toBe(true);
    expect(f.node("#browser-screenshot-panel").hidden).toBe(false);
    expect(f.node("#browser-selected-ref").textContent).toBe("e1");
    expect(f.node("#browser-revision").textContent).toBe(f.revision);
    f.node("#browser-screenshot-tab").emit("keydown", { key: "Home" });
    expect(f.node("#browser-text-tab").tabIndex).toBe(0);
    expect(f.node("#browser-text-panel").hidden).toBe(false);
    expect(f.calls).toHaveLength(callCount);
  });

  it("keeps the complete revision for actions after a presentation tab change", async () => {
    const f = fixture(); await f.controller.refresh();
    f.node("#browser-element-list").emit("click", { target: f.node("#browser-element-list").children[0] });
    f.node("#browser-screenshot-tab").emit("click");
    f.node("#browser-screenshot-toggle").checked = false;
    await f.controller.clickSelected();
    expect(f.calls.filter(call => call.name === "browser.click")).toEqual([{ name: "browser.click", input: { sessionId: "browser-fixture", expectedRevision: f.revision, ref: "e1" } }]);
    expect(f.node("#browser-revision").title).toBe(f.revision);
  });

  it("clears an older screenshot when the next observation contains text only", async () => {
    const f = fixture(); await f.controller.refresh();
    expect(f.node("#browser-preview").hidden).toBe(false);
    f.omitScreenshot(); f.node("#browser-screenshot-toggle").checked = false;
    await f.controller.observe();
    expect(f.calls.at(-1)).toEqual({ name: "browser.observe", input: { sessionId: "browser-fixture", includeScreenshot: false } });
    expect(f.node("#browser-preview").hidden).toBe(true);
    expect(f.node("#browser-preview").src).toBe("");
    expect(f.node("#browser-preview-empty").hidden).toBe(false);
    expect(f.node("#browser-revision").textContent).toBe("next-revision");
  });
});
