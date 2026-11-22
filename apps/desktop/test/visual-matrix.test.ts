import { describe, expect, it } from "vitest";

import { assertVisualContext, VISUAL_MATRIX, visualContextKey, visualScreenshotPath } from "../src/visual-matrix.js";

describe("v2 visual coverage", () => {
  it("requires all eight language, theme, and CSS viewport combinations", () => {
    expect(VISUAL_MATRIX.map(visualContextKey).sort()).toEqual([
      "en/dark/1040x680", "en/dark/1360x860", "en/light/1040x680", "en/light/1360x860",
      "zh-CN/dark/1040x680", "zh-CN/dark/1360x860", "zh-CN/light/1040x680", "zh-CN/light/1360x860",
    ]);
    expect(new Set(VISUAL_MATRIX.map((context) => visualScreenshotPath(context, "home-simple"))).size).toBe(8);
  });

  it("rejects zoomed, stale-theme, stale-locale, and incorrectly sized captures", () => {
    const expected = { language: "zh-CN", theme: "light", width: 1040, height: 680 } as const;
    const actual = { ...expected, zoom: 1 };
    expect(() => assertVisualContext(expected, actual)).not.toThrow();
    for (const change of [{ zoom: 1.1 }, { width: 945 }, { height: 618 }, { theme: "dark" }, { language: "en" }]) {
      expect(() => assertVisualContext(expected, { ...actual, ...change })).toThrow("matrix cell");
    }
  });

  it("never turns a surface label into an output path escape", () => {
    const context = VISUAL_MATRIX[0]!;
    for (const surface of ["../outside", "C:\\outside", "/absolute", "nested/path", "", "home.png"]) {
      expect(() => visualScreenshotPath(context, surface)).toThrow();
    }
  });
});
