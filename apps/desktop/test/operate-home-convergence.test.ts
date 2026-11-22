import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const source = (name: string) => readFileSync(resolve(import.meta.dirname, "../src/renderer", name), "utf8");
describe("compact home and connection surfaces", () => {
  it("uses one Overview for Full and Simple without hidden legacy screens", () => {
    const view = source("view-overview.ts");
    expect((view.match(/class="v2-overview"/gu) ?? []).length).toBe(1);
    expect(view).toContain('id="v2-pending-summary"');
    expect(view).toContain('id="home-active-work-carousel"');
    expect(view).not.toContain("simple-overview");
    expect(source("view-registry.ts")).not.toMatch(/id: "(agent|runs)"/u);
  });
  it("renders only Agent-reported numeric progress and preserves selection navigation", () => {
    const main = source("main.ts");
    expect(main).toContain("const progress = task?.progress;");
    expect(main).toContain("track.hidden = !known");
    expect(main).toContain("progress.current! / progress.total!");
    expect(main).toContain("activeWorkCarousel.move(-1)");
    expect(main).toContain("activeWorkCarousel.move(1)");
    expect(main).not.toContain("latestProgressLine");
  });
  it("keeps provider configuration in a modal drawer and copy targets honest", () => {
    expect(source("view-agent.ts")).toContain('<dialog id="connection-drawer"');
    expect(source("connections-controller.ts")).toContain("drawer.showModal()");
    expect(source("view-overview.ts")).toContain("Copy tunnel ID");
    expect(source("connections-controller.ts")).not.toContain('sessionCount > 0) return { label: "ChatGPT');
    expect(source("v2.css")).toContain(".v2-drawer-heading h2");
  });
});
