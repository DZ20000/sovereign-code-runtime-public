import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("operate home convergence", () => {
  it("keeps recent records in history instead of rendering them on Home", () => {
    const overview = source("apps/desktop/src/renderer/view-overview.ts");
    const registry = source("apps/desktop/src/renderer/view-registry.ts");
    expect(overview).not.toContain("home-activity-panel");
    expect(overview).not.toContain("overview-run-list");
    expect(registry).toContain('id: "runs"');
    expect(registry).toContain('navigationLabel: "Task History"');
  });

  it("uses one carousel frame, a positional current card and local status color", () => {
    const css = source("apps/desktop/src/renderer/home-active-work-polish.css");
    const finalSection = css.slice(css.lastIndexOf("/* Operate convergence:"));
    expect(finalSection).toContain(".active-work-carousel::before");
    expect(finalSection).toContain("content: none !important");
    expect(finalSection).toContain("-webkit-mask-image: none !important");

    const currentStart = finalSection.indexOf(
      "html #view-overview .active-work-line.is-focused,",
    );
    const markerStart = finalSection.indexOf(
      "html #view-overview .active-work-line-marker",
      currentStart,
    );
    const currentBlock = finalSection.slice(currentStart, markerStart);
    expect(currentStart).toBeGreaterThan(-1);
    expect(markerStart).toBeGreaterThan(currentStart);
    expect(currentBlock).toContain("border-color: transparent !important;");
    expect(currentBlock).toContain("background: transparent !important;");
    expect(currentBlock).toContain("box-shadow: none !important;");
    expect(currentBlock).not.toContain("var(--ui-accent)");
    expect(currentBlock).not.toContain("var(--ui-alert)");

    const attentionMarkerStart = finalSection.indexOf(
      "html #view-overview .active-work-line-attention .active-work-line-marker",
      markerStart,
    );
    const overviewRowStart = finalSection.indexOf(
      "html #view-overview .overview-attention-row:is(.is-warning, .is-error)",
    );
    expect(attentionMarkerStart).toBeGreaterThan(markerStart);
    expect(overviewRowStart).toBeGreaterThan(attentionMarkerStart);
    expect(
      finalSection.slice(attentionMarkerStart, overviewRowStart),
    ).toContain("var(--ui-alert)");

    const overviewWarningMarker = finalSection.indexOf(
      ".overview-attention-row.is-warning",
      overviewRowStart,
    );
    const overviewErrorMarker = finalSection.indexOf(
      ".overview-attention-row.is-error",
      overviewWarningMarker + 1,
    );
    const overviewRowBlock = finalSection.slice(
      overviewRowStart,
      overviewWarningMarker,
    );
    expect(overviewRowBlock).not.toContain("var(--ui-alert)");
    expect(overviewRowBlock).not.toContain("var(--ui-danger)");
    expect(
      finalSection.slice(overviewWarningMarker, overviewErrorMarker),
    ).toContain("var(--ui-alert)");
    expect(finalSection.slice(overviewErrorMarker)).toContain(
      "var(--ui-danger)",
    );
  });
  it("keeps Active Work motion governed by the app reduced-motion setting", () => {
    const main = source("apps/desktop/src/renderer/main.ts");
    const css = source("apps/desktop/src/renderer/home-active-work-polish.css");
    const activeWorkImport = main.indexOf(
      'import "./home-active-work-polish.css";',
    );
    const historicalImport = main.indexOf(
      'import "./home-visualqa-restoration.css";',
    );
    const motionStart = css.indexOf(
      "html.reduce-motion #view-overview .active-work-line",
    );
    const convergenceStart = css.indexOf("/* Operate convergence:");

    expect(activeWorkImport).toBeGreaterThan(historicalImport);
    expect(motionStart).toBeGreaterThan(-1);
    expect(convergenceStart).toBeGreaterThan(motionStart);

    const motionSection = css.slice(motionStart, convergenceStart);
    expect(motionSection).toContain("transition: none !important;");
    expect(motionSection).toContain("animation: none !important;");
    expect(motionSection).not.toContain(
      "@media (prefers-reduced-motion: reduce)",
    );
  });

  it("keeps status summaries inside safe edges with semantic local and neutral permission states", () => {
    const css = source(
      "apps/desktop/src/renderer/operate-shell-connection-polish.css",
    );
    const finalSection = css.slice(css.lastIndexOf("/* Operate status bar:"));
    expect(finalSection).toContain("padding-inline: 12px !important");
    expect(finalSection).toContain(".statusbar-local-icon");
    expect(finalSection).toContain("width: 14px");
    expect(finalSection).toContain("flex: 0 0 14px");
    expect(finalSection).toMatch(
      /\.statusbar-permission \{[\s\S]*?color: var\(--ui-text-muted\) !important;/u,
    );
    expect(finalSection).toContain("#status-authority.status-error");
  });

  it("samples real carousel motion before screenshot transition suppression", () => {
    const visual = source("apps/desktop/src/visual-test.ts");
    const overviewVerification = source(
      "apps/desktop/src/visual-overview-verification.ts",
    );
    const firstRendererLoad = visual.indexOf(
      "await window.loadURL(`${RENDERER_ORIGIN}index.html`)",
    );
    const motionPreferenceEmulation = visual.indexOf(
      '"Emulation.setEmulatedMedia"',
    );
    const paintsWhileHidden = visual.indexOf("paintWhenInitiallyHidden: true");
    const motionCall = visual.indexOf(
      "const overviewVerification = await verifyOverviewActivity",
    );
    const evidenceWrite = visual.indexOf(
      'join(OUTPUT_ROOT, "overview-motion.json")',
    );
    const evidenceGuard = visual.indexOf("if (!overviewVerification.ok");
    const transitionSuppression = visual.indexOf(
      "transition-duration: 0s !important",
    );
    expect(firstRendererLoad).toBeGreaterThan(-1);
    expect(motionPreferenceEmulation).toBeGreaterThan(firstRendererLoad);
    // Motion is sampled in a hidden window, so it must keep painting unthrottled.
    expect(paintsWhileHidden).toBeGreaterThan(-1);
    expect(visual).toContain("backgroundThrottling: false");
    expect(motionCall).toBeGreaterThan(motionPreferenceEmulation);
    expect(evidenceWrite).toBeGreaterThan(motionCall);
    expect(evidenceGuard).toBeGreaterThan(evidenceWrite);
    expect(transitionSuppression).toBeGreaterThan(evidenceGuard);
    expect(visual).not.toContain("window.hide()");
    expect(visual).toContain('value: "no-preference"');
    expect(visual).toContain("reducedMotion: false");
    expect(overviewVerification).not.toContain(
      "#overview-run-list .overview-activity-row",
    );
    expect(overviewVerification).toContain("motionMidIsIntermediate");
    expect(overviewVerification).toContain("intermediateSampleCount");
    expect(overviewVerification).toContain("hasTimedTransformTransition");
  });
});
