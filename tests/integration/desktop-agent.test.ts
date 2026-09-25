import { describe, expect, it } from "vitest";

import {
  permissionProfileAllows,
  type RuntimePermissionProfile,
  type ToolPermissionLevel,
} from "../../packages/runtime-core/src/index.js";

function allowed(profile: RuntimePermissionProfile, level: ToolPermissionLevel): boolean {
  return permissionProfileAllows(profile, level);
}

describe("ChatGPT Web permission profiles", () => {
  it("keeps L1 and L2 bounded to their declared authority", () => {
    expect(allowed("observe", "observe")).toBe(true);
    expect(allowed("observe", "workspace")).toBe(false);
    expect(allowed("observe", "consequential")).toBe(false);

    expect(allowed("workspace", "observe")).toBe(true);
    expect(allowed("workspace", "workspace")).toBe(true);
    expect(allowed("workspace", "consequential")).toBe(false);
  });

  it("allows L3 through the consequential profile and every level through L4 Bypass", () => {
    expect(allowed("consequential", "observe")).toBe(true);
    expect(allowed("consequential", "workspace")).toBe(true);
    expect(allowed("consequential", "consequential")).toBe(true);

    expect(allowed("bypass", "observe")).toBe(true);
    expect(allowed("bypass", "workspace")).toBe(true);
    expect(allowed("bypass", "consequential")).toBe(true);
  });
});
