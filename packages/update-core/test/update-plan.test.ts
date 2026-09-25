import { describe, expect, it } from "vitest";
import { planComponentUpdate } from "../src/update-plan.js";

describe("planComponentUpdate", () => {
  it("keeps renderer-only changes inside the live renderer boundary", () => {
    const plan = planComponentUpdate([
      { path: "renderer/index.html", role: "renderer", change: "modified" },
      { path: "renderer/assets/main.js", role: "web-assets", change: "modified" },
    ]);

    expect(plan.mode).toBe("renderer-reload");
    expect(plan.requiresApplicationRestart).toBe(false);
    expect(plan.phases).toContain("capture-view-state");
    expect(plan.phases).toContain("restore-view-state");
  });

  it("uses a rolling cutover for Runtime Host and Gateway changes", () => {
    const plan = planComponentUpdate([
      { path: "runtime-host.cjs", role: "runtime-host", change: "modified" },
      { path: "gateway.cjs", role: "gateway", change: "modified" },
      { path: "renderer/index.html", role: "renderer", change: "modified" },
    ]);

    expect(plan.mode).toBe("runtime-rolling");
    expect(plan.requiresQuiescence).toBe(true);
    expect(plan.requiresApplicationRestart).toBe(false);
    expect(plan.phases).toContain("drain-in-flight-work");
    expect(plan.phases).toContain("checkpoint-tasks");
  });

  it("fails native and trust-boundary changes closed to a restart", () => {
    for (const role of [
      "desktop-shell",
      "preload",
      "node-runtime",
      "host-guardian",
      "native-agent",
    ]) {
      const plan = planComponentUpdate([
        { path: `${role}.bin`, role, change: "modified" },
      ]);
      expect(plan.mode).toBe("application-restart");
      expect(plan.requiresApplicationRestart).toBe(true);
    }
  });

  it("requires maintenance for contract and breaking migrations", () => {
    for (const databaseMigration of ["contract", "breaking"] as const) {
      const plan = planComponentUpdate(
        [{ path: "schema.sql", role: "database", change: "modified" }],
        { databaseMigration },
      );
      expect(plan.mode).toBe("maintenance");
      expect(plan.phases).toContain("backup-state");
    }
  });

  it("allows only explicitly declared online expand migrations to roll", () => {
    const restart = planComponentUpdate(
      [{ path: "schema.sql", role: "database", change: "modified" }],
      { databaseMigration: "expand" },
    );
    expect(restart.mode).toBe("application-restart");

    const rolling = planComponentUpdate(
      [{ path: "schema.sql", role: "database", change: "modified" }],
      { databaseMigration: "expand", onlineExpandMigration: true },
    );
    expect(rolling.mode).toBe("runtime-rolling");
  });

  it("fails unknown roles closed and honors policy opt-outs", () => {
    expect(
      planComponentUpdate([
        { path: "mystery.bin", role: "future-component", change: "added" },
      ]).mode,
    ).toBe("application-restart");

    expect(
      planComponentUpdate(
        [{ path: "index.html", role: "renderer", change: "modified" }],
        { allowRendererReload: false },
      ).mode,
    ).toBe("application-restart");

    expect(
      planComponentUpdate(
        [{ path: "runtime.cjs", role: "runtime-host", change: "modified" }],
        { allowRuntimeRolling: false },
      ).mode,
    ).toBe("application-restart");
  });

  it("returns no-op for an empty verified diff", () => {
    expect(planComponentUpdate([])).toMatchObject({
      mode: "no-op",
      phases: [],
      rollbackRequired: false,
    });
  });
});
