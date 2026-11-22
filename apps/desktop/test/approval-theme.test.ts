import { afterEach, describe, expect, it, vi } from "vitest";
import type {} from "../src/renderer/global.js";

async function loadApproval(preferences: string | null, dark: boolean) {
  vi.resetModules();
  const changes = new Map<string, () => void>();
  const lifecycle = new Map<string, () => void>();
  const media = {
    matches: dark,
    addEventListener: vi.fn((type: string, listener: () => void) => changes.set(type, listener)),
    removeEventListener: vi.fn(),
  };
  const element = () => ({
    textContent: "", hidden: false, disabled: false, dataset: {} as Record<string, string>,
    classList: { toggle: vi.fn() }, addEventListener: vi.fn(), setAttribute: vi.fn(), focus: vi.fn(),
  });
  const elements = new Map<string, ReturnType<typeof element>>();
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, lang: "" };
  const storage = { getItem: vi.fn(() => preferences), setItem: vi.fn() };
  const approval = { getCurrent: vi.fn().mockResolvedValue(null), resolve: vi.fn(), dismiss: vi.fn() };
  const clearInterval = vi.fn();
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", {
    documentElement: root, getElementById: getElement,
    querySelector: (selector: string) => selector === ".approval-shell" ? getElement("shell") : null,
  });
  vi.stubGlobal("window", {
    sovereignApproval: approval, matchMedia: () => media,
    addEventListener: (type: string, listener: () => void) => lifecycle.set(type, listener),
    setInterval: vi.fn(() => 1), clearInterval,
  });
  await import("../src/renderer/approval.js");
  await Promise.resolve();
  return { root, media, changes, lifecycle, clearInterval, approval, storage };
}
afterEach(() => vi.unstubAllGlobals());

describe("independent approval theme", () => {
  it.each([null, "{invalid", '{"fontScale":1.2}', '{"theme":"system"}'])("follows system without a saved explicit theme: %s", async preferences => {
    const f = await loadApproval(preferences, true);
    expect(f.root.dataset.theme).toBe("dark");
    expect(f.root.style.colorScheme).toBe("dark");
    f.media.matches = false;
    f.changes.get("change")!();
    expect(f.root.dataset.theme).toBe("light");
    expect(f.root.style.colorScheme).toBe("light");
    expect(f.approval.getCurrent).toHaveBeenCalledTimes(1);
    expect(f.approval.resolve).not.toHaveBeenCalled();
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.lifecycle.get("beforeunload")!();
    expect(f.media.removeEventListener).toHaveBeenCalledWith("change", f.changes.get("change"));
    expect(f.clearInterval).toHaveBeenCalledWith(1);
  });

  it.each(["light", "dark"])("preserves an explicit %s choice across system changes", async theme => {
    const f = await loadApproval(JSON.stringify({ theme }), theme !== "dark");
    expect(f.root.dataset.theme).toBe(theme);
    f.media.matches = !f.media.matches;
    f.changes.get("change")!();
    expect(f.root.dataset.theme).toBe(theme);
    expect(f.root.style.colorScheme).toBe(theme);
  });
});
