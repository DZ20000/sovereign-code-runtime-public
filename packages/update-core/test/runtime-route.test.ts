import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeRouteRegistry,
  type RuntimeRouteTarget,
} from "../src/runtime-route.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly registry: RuntimeRouteRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-runtime-route-"));
  roots.push(root);
  return {
    root,
    registry: new RuntimeRouteRegistry({ rootDirectory: root }),
  };
}

function target(releaseId: string, suffix: string): RuntimeRouteTarget {
  return {
    instanceId: `runtime-instance-${suffix}`,
    releaseId,
    routeId: `route:${suffix}`,
    checkpointId: `checkpoint-${suffix}`,
    fencingToken: `fence-${suffix}`,
  };
}

describe("RuntimeRouteRegistry", () => {
  it("bootstraps, switches, commits, and preserves an append-only hash chain", async () => {
    const { registry } = await fixture();
    const first = target("runtime-release-1", "one");
    const second = target("runtime-release-2", "two");

    const bootstrap = await registry.bootstrap(first, {
      cutoverId: "bootstrap-1",
      expectedGeneration: null,
    });
    expect(bootstrap).toMatchObject({
      generation: 1,
      operation: "bootstrap",
      active: first,
      previous: null,
    });

    const switched = await registry.switchTo(second, {
      cutoverId: "cutover-2",
      expectedGeneration: 1,
    });
    expect(switched).toMatchObject({
      generation: 2,
      operation: "switch",
      active: second,
      previous: first,
    });

    const committed = await registry.commit({
      cutoverId: "cutover-2-commit",
      expectedGeneration: 2,
    });
    expect(committed).toMatchObject({
      generation: 3,
      operation: "commit",
      active: second,
      previous: null,
    });

    const revisions = await registry.readAll();
    expect(revisions).toHaveLength(3);
    expect(revisions[0]?.previousRecordSha256).toBeNull();
    expect(revisions[1]?.previousRecordSha256).toBe(revisions[0]?.recordSha256);
    expect(revisions[2]?.previousRecordSha256).toBe(revisions[1]?.recordSha256);
  });

  it("rolls a switched route back by swapping active and previous", async () => {
    const { registry } = await fixture();
    const first = target("runtime-release-1", "one");
    const second = target("runtime-release-2", "two");
    await registry.bootstrap(first, {
      cutoverId: "bootstrap-1",
      expectedGeneration: null,
    });
    await registry.switchTo(second, {
      cutoverId: "cutover-2",
      expectedGeneration: 1,
    });

    const rollback = await registry.rollback({
      cutoverId: "cutover-2-rollback",
      expectedGeneration: 2,
    });
    expect(rollback).toMatchObject({
      generation: 3,
      operation: "rollback",
      active: first,
      previous: second,
    });
    await expect(registry.readCurrent()).resolves.toEqual(rollback);
  });

  it("rejects stale generations and candidate route or fencing reuse", async () => {
    const { registry } = await fixture();
    const first = target("runtime-release-1", "one");
    await registry.bootstrap(first, {
      cutoverId: "bootstrap-1",
      expectedGeneration: null,
    });

    await expect(
      registry.switchTo(target("runtime-release-2", "two"), {
        cutoverId: "stale-cutover",
        expectedGeneration: null,
      }),
    ).rejects.toThrow(/generation changed/u);

    await expect(
      registry.switchTo(
        { ...target("runtime-release-2", "two"), routeId: first.routeId },
        { cutoverId: "route-reuse", expectedGeneration: 1 },
      ),
    ).rejects.toThrow(/route ID/u);

    await expect(
      registry.switchTo(
        {
          ...target("runtime-release-2", "two"),
          fencingToken: first.fencingToken,
        },
        { cutoverId: "fence-reuse", expectedGeneration: 1 },
      ),
    ).rejects.toThrow(/fencing token/u);
  });

  it("serializes two registry instances so one stale switch loses", async () => {
    const { root, registry } = await fixture();
    await registry.bootstrap(target("runtime-release-1", "one"), {
      cutoverId: "bootstrap-1",
      expectedGeneration: null,
    });
    const left = new RuntimeRouteRegistry({ rootDirectory: root });
    const right = new RuntimeRouteRegistry({ rootDirectory: root });
    const outcomes = await Promise.allSettled([
      left.switchTo(target("runtime-release-2", "two"), {
        cutoverId: "concurrent-left",
        expectedGeneration: 1,
      }),
      right.switchTo(target("runtime-release-3", "three"), {
        cutoverId: "concurrent-right",
        expectedGeneration: 1,
      }),
    ]);

    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === "rejected"),
    ).toHaveLength(1);
    await expect(registry.readCurrent()).resolves.toMatchObject({
      generation: 2,
    });
  });

  it("detects tampering, generation gaps, and unexpected files", async () => {
    const { root, registry } = await fixture();
    await registry.bootstrap(target("runtime-release-1", "one"), {
      cutoverId: "bootstrap-1",
      expectedGeneration: null,
    });
    const revisionsDirectory = join(root, "revisions");
    const [fileName] = await readdir(revisionsDirectory);
    const path = join(revisionsDirectory, fileName!);
    const revision = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      path,
      `${JSON.stringify({
        ...revision,
        active: {
          ...(revision.active as Record<string, unknown>),
          releaseId: "runtime-release-tampered",
        },
      })}\n`,
      "utf8",
    );
    await expect(registry.readAll()).rejects.toThrow(/digest does not match/u);

    await rm(path);
    await writeFile(join(revisionsDirectory, "unexpected.txt"), "x", "utf8");
    await expect(registry.readAll()).rejects.toThrow(/unexpected entry/u);
  });

  it("keeps commit idempotent only at the caller's current generation", async () => {
    const { registry } = await fixture();
    const first = target("runtime-release-1", "one");
    await registry.bootstrap(first, {
      cutoverId: "bootstrap-1",
      expectedGeneration: null,
    });
    const committed = await registry.commit({
      cutoverId: "commit-1",
      expectedGeneration: 1,
    });
    expect(committed).toMatchObject({ generation: 2, operation: "commit" });
    await expect(
      registry.commit({
        cutoverId: "commit-stale",
        expectedGeneration: 1,
      }),
    ).rejects.toThrow(/generation changed/u);
    await expect(
      registry.commit({
        cutoverId: "commit-idempotent",
        expectedGeneration: 2,
      }),
    ).resolves.toEqual(committed);
  });

  it("validates opaque route identities without accepting traversal-like values", async () => {
    const { registry } = await fixture();
    await expect(
      registry.bootstrap(
        { ...target("runtime-release-1", "one"), routeId: "route:../escape" },
        { cutoverId: "bootstrap-invalid", expectedGeneration: null },
      ),
    ).rejects.toThrow(/route ID is invalid/u);
  });
});
