import { describe, expect, it } from "vitest";

import {
  applyTaskProgressAccessibility,
  taskProgressAccessibleLabel,
} from "../src/renderer/task-progress-accessibility.js";

class FakeProgressbar {
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

describe("task progress accessibility", () => {
  it("uses a stable fallback label for missing structured labels", () => {
    expect(taskProgressAccessibleLabel(null)).toBe("Task progress");
    expect(taskProgressAccessibleLabel("   ")).toBe("Task progress");
    expect(taskProgressAccessibleLabel("Release verification")).toBe(
      "Release verification",
    );
  });

  it("publishes bounded determinate progress", () => {
    const target = new FakeProgressbar();
    applyTaskProgressAccessibility(target, {
      label: "Validation",
      percent: 127.6,
      valueText: "8 of 10",
    });

    expect(Object.fromEntries(target.attributes)).toEqual({
      role: "progressbar",
      "aria-label": "Validation",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuetext": "8 of 10",
      "aria-valuenow": "100",
    });
  });

  it("omits aria-valuenow for indeterminate progress", () => {
    const target = new FakeProgressbar();
    target.setAttribute("aria-valuenow", "40");
    applyTaskProgressAccessibility(target, {
      label: null,
      percent: null,
      valueText: "Live activity · structured progress not reported",
    });

    expect(target.attributes.get("role")).toBe("progressbar");
    expect(target.attributes.get("aria-label")).toBe("Task progress");
    expect(target.attributes.get("aria-valuetext")).toContain(
      "structured progress not reported",
    );
    expect(target.attributes.has("aria-valuenow")).toBe(false);
  });
});
