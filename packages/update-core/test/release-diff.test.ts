import { describe, expect, it } from "vitest";
import {
  RELEASE_SNAPSHOT_SCHEMA_VERSION,
  diffReleaseSnapshots,
  parseReleaseSnapshot,
  planReleaseTransition,
  type ReleaseComponentSnapshot,
  type ReleaseSnapshot,
} from "../src/release-diff.js";

function component(
  path: string,
  role: string,
  digestCharacter: string,
  bytes = 10,
): ReleaseComponentSnapshot {
  return {
    path,
    role,
    sha256: digestCharacter.repeat(64),
    bytes,
  };
}

function snapshot(
  releaseId: string,
  sequence: number,
  components: readonly ReleaseComponentSnapshot[],
): ReleaseSnapshot {
  return {
    schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
    releaseId,
    releaseSequence: sequence,
    version: `0.${sequence}.0`,
    components,
  };
}

describe("release snapshot component diff", () => {
  it("plans a renderer-only reload from signed component snapshots", () => {
    const current = snapshot("release-1", 1, [
      component("renderer/index.html", "renderer", "a"),
      component("renderer/assets/main.js", "renderer", "b"),
      component("runtime-host.cjs", "runtime-host", "c"),
    ]);
    const candidate = snapshot("release-2", 2, [
      component("renderer/index.html", "renderer", "d"),
      component("renderer/assets/main.js", "renderer", "e"),
      component("runtime-host.cjs", "runtime-host", "c"),
    ]);

    const transition = planReleaseTransition(current, candidate);

    expect(transition.plan.mode).toBe("renderer-reload");
    expect(transition.changes).toEqual([
      {
        path: "renderer/assets/main.js",
        role: "renderer",
        change: "modified",
      },
      {
        path: "renderer/index.html",
        role: "renderer",
        change: "modified",
      },
    ]);
  });

  it("selects rolling runtime cutover when Gateway or Runtime Host changes", () => {
    const transition = planReleaseTransition(
      snapshot("release-1", 1, [
        component("runtime-host.cjs", "runtime-host", "a"),
        component("gateway.cjs", "gateway", "b"),
      ]),
      snapshot("release-2", 2, [
        component("runtime-host.cjs", "runtime-host", "c"),
        component("gateway.cjs", "gateway", "d"),
      ]),
    );

    expect(transition.plan.mode).toBe("runtime-rolling");
    expect(transition.changes).toHaveLength(2);
  });

  it("does not permit a role relabel to downgrade a native restart", () => {
    const transition = planReleaseTransition(
      snapshot("release-1", 1, [
        component("Sovereign.exe", "desktop-shell", "a"),
      ]),
      snapshot("release-2", 2, [component("Sovereign.exe", "renderer", "b")]),
    );

    expect(transition.changes).toEqual([
      { path: "Sovereign.exe", role: "desktop-shell", change: "removed" },
      { path: "Sovereign.exe", role: "renderer", change: "added" },
    ]);
    expect(transition.plan.mode).toBe("application-restart");
  });

  it("treats portable path case changes conservatively", () => {
    const diff = diffReleaseSnapshots(
      snapshot("release-1", 1, [
        component("renderer/Main.js", "renderer", "a"),
      ]),
      snapshot("release-2", 2, [
        component("renderer/main.js", "renderer", "a"),
      ]),
    );

    expect(diff.changes).toEqual([
      { path: "renderer/Main.js", role: "renderer", change: "removed" },
      { path: "renderer/main.js", role: "renderer", change: "added" },
    ]);
  });

  it("records additions, removals, byte changes, and digest changes", () => {
    const diff = diffReleaseSnapshots(
      snapshot("release-1", 1, [
        component("removed.bin", "native-agent", "a"),
        component("same.bin", "runtime-host", "b"),
        component("size.bin", "renderer", "c", 10),
      ]),
      snapshot("release-2", 2, [
        component("added.bin", "renderer", "d"),
        component("same.bin", "runtime-host", "e"),
        component("size.bin", "renderer", "c", 11),
      ]),
    );

    expect(diff.changes).toEqual([
      { path: "added.bin", role: "renderer", change: "added" },
      { path: "removed.bin", role: "native-agent", change: "removed" },
      { path: "same.bin", role: "runtime-host", change: "modified" },
      { path: "size.bin", role: "renderer", change: "modified" },
    ]);
  });

  it("returns no-op for metadata-only release changes", () => {
    const current = snapshot("release-1", 1, [
      component("renderer/index.html", "renderer", "a"),
    ]);
    const candidate = snapshot("release-2", 2, [
      component("renderer/index.html", "renderer", "a"),
    ]);

    expect(planReleaseTransition(current, candidate).plan.mode).toBe("no-op");
  });

  it("rejects non-increasing release sequences and identity reuse", () => {
    const current = snapshot("release-1", 2, []);
    expect(() =>
      diffReleaseSnapshots(current, snapshot("release-2", 2, [])),
    ).toThrow(/newer/u);
    expect(() =>
      diffReleaseSnapshots(current, snapshot("release-1", 3, [])),
    ).toThrow(/must differ/u);
  });

  it("rejects traversal, noncanonical versions, unknown fields, and case-fold collisions", () => {
    expect(() =>
      parseReleaseSnapshot({
        ...snapshot("release-1", 1, []),
        version: "01.0.0",
      }),
    ).toThrow(/canonical/u);
    expect(() =>
      parseReleaseSnapshot({
        ...snapshot("release-1", 1, [component("../escape", "renderer", "a")]),
      }),
    ).toThrow(/unsafe|portable/u);
    expect(() =>
      parseReleaseSnapshot({
        ...snapshot("release-1", 1, []),
        unsignedHint: "renderer",
      }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      parseReleaseSnapshot(
        snapshot("release-1", 1, [
          component("Renderer/Main.js", "renderer", "a"),
          component("renderer/main.js", "renderer", "b"),
        ]),
      ),
    ).toThrow(/duplicate portable path/u);
  });
});
