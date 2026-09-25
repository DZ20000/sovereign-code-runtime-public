import { describe, expect, it } from "vitest";

import {
  normalizePersistedView,
  resolveInitialView,
} from "../src/renderer/navigation-state.js";

describe("navigation state", () => {
  it("restores the current view on reload even when cold-start preference is Home", () => {
    expect(resolveInitialView({
      lastView: "tasks",
      startupView: "overview",
      experienceMode: "full",
      isReload: true,
    })).toBe("tasks");
  });

  it("uses the configured view on a cold launch", () => {
    expect(resolveInitialView({
      lastView: "settings",
      startupView: "tasks",
      experienceMode: "full",
      isReload: false,
    })).toBe("tasks");
    expect(resolveInitialView({
      lastView: "settings",
      startupView: "agent",
      experienceMode: "full",
      isReload: false,
    })).toBe("agent");
    expect(resolveInitialView({
      lastView: "settings",
      startupView: "runs",
      experienceMode: "full",
      isReload: false,
    })).toBe("runs");
  });

  it("supports an explicit last-view cold-start preference", () => {
    expect(resolveInitialView({
      lastView: "settings",
      startupView: "last",
      experienceMode: "full",
      isReload: false,
    })).toBe("settings");
  });

  it("does not restore an advanced view while simple mode hides it", () => {
    expect(resolveInitialView({
      lastView: "terminal",
      startupView: "last",
      experienceMode: "simple",
      isReload: false,
    })).toBe("overview");
    expect(normalizePersistedView("python", "simple")).toBe("overview");
  });

  it("ignores invalid persisted values", () => {
    expect(normalizePersistedView("not-a-view", "full")).toBeNull();
    expect(normalizePersistedView(null, "full")).toBeNull();
  });
});
