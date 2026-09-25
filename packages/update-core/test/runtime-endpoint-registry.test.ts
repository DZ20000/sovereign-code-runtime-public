import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_ENDPOINT_SCHEMA_VERSION,
  RuntimeEndpointRegistry,
  type RuntimeEndpointRecord,
} from "../src/runtime-endpoint-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-runtime-endpoint-"));
  roots.push(root);
  let now = 100;
  return {
    root,
    registry: new RuntimeEndpointRegistry({
      rootDirectory: root,
      now: () => now++,
    }),
  };
}

function endpoint(
  instanceId: string,
  releaseId: string,
  marker: string,
): RuntimeEndpointRecord {
  return {
    schemaVersion: RUNTIME_ENDPOINT_SCHEMA_VERSION,
    instanceId,
    releaseId,
    endpointId: `pipe-${instanceId}`,
    processId: instanceId.endsWith("1") ? 1001 : 1002,
    protocolVersion: 1,
    manifestSha256: marker.repeat(64),
    startedAt: 50,
  };
}

describe("RuntimeEndpointRegistry", () => {
  it("registers immutable endpoints and atomically switches and rolls back", async () => {
    const { registry } = await fixture();
    await registry.register(endpoint("instance-1", "release-1", "a"));
    await registry.register(endpoint("instance-2", "release-2", "b"));

    const first = await registry.activate("instance-1", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: null,
      expectedActiveInstanceId: null,
    });
    expect(first).toMatchObject({
      generation: 1,
      active: { instanceId: "instance-1" },
      previous: null,
    });

    const second = await registry.activate("instance-2", {
      checkpointId: "checkpoint-2",
      fencingToken: "fence-2",
      expectedGeneration: 1,
      expectedActiveInstanceId: "instance-1",
    });
    expect(second).toMatchObject({
      generation: 2,
      active: { instanceId: "instance-2" },
      previous: { instanceId: "instance-1" },
    });
    await expect(registry.resolveActive()).resolves.toMatchObject({
      endpoint: {
        instanceId: "instance-2",
        releaseId: "release-2",
        endpointId: "pipe-instance-2",
      },
    });

    const rolledBack = await registry.rollback({
      checkpointId: "checkpoint-rollback",
      fencingToken: "fence-rollback",
      expectedGeneration: 2,
    });
    expect(rolledBack).toMatchObject({
      generation: 3,
      active: { instanceId: "instance-1" },
      previous: { instanceId: "instance-2" },
    });
  });

  it("is idempotent for identical registration and rejects instance identity reuse", async () => {
    const { registry } = await fixture();
    const record = endpoint("instance-1", "release-1", "a");
    const first = await registry.register(record);
    const second = await registry.register(record);
    expect(second).toEqual(first);

    await expect(
      registry.register({
        ...record,
        releaseId: "release-2",
        manifestSha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/different content/u);
  });

  it("rejects stale generation and active-instance assumptions", async () => {
    const { registry } = await fixture();
    await registry.register(endpoint("instance-1", "release-1", "a"));
    await registry.register(endpoint("instance-2", "release-2", "b"));
    await registry.activate("instance-1", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: null,
    });

    await expect(
      registry.activate("instance-2", {
        checkpointId: "checkpoint-2",
        fencingToken: "fence-2",
        expectedGeneration: 7,
      }),
    ).rejects.toThrow(/generation changed/u);
    await expect(
      registry.activate("instance-2", {
        checkpointId: "checkpoint-2",
        fencingToken: "fence-2",
        expectedGeneration: 1,
        expectedActiveInstanceId: "wrong-instance",
      }),
    ).rejects.toThrow(/Active Runtime instance changed/u);
  });

  it("serializes cross-instance activations so only one stale generation wins", async () => {
    const { root, registry } = await fixture();
    for (const [instanceId, releaseId, marker] of [
      ["instance-1", "release-1", "a"],
      ["instance-2", "release-2", "b"],
      ["instance-3", "release-3", "c"],
    ] as const) {
      await registry.register(endpoint(instanceId, releaseId, marker));
    }
    await registry.activate("instance-1", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: null,
    });

    const left = new RuntimeEndpointRegistry({ rootDirectory: root });
    const right = new RuntimeEndpointRegistry({ rootDirectory: root });
    const results = await Promise.allSettled([
      left.activate("instance-2", {
        checkpointId: "checkpoint-2",
        fencingToken: "fence-2",
        expectedGeneration: 1,
      }),
      right.activate("instance-3", {
        checkpointId: "checkpoint-3",
        fencingToken: "fence-3",
        expectedGeneration: 1,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(registry.readPointer()).resolves.toMatchObject({
      generation: 2,
    });
  });

  it("detects active endpoint record tampering through the pointer digest", async () => {
    const { root, registry } = await fixture();
    await registry.register(endpoint("instance-1", "release-1", "a"));
    await registry.activate("instance-1", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: null,
    });

    const path = join(root, "instances", "instance-1.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    record.endpointId = "pipe-tampered";
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    await expect(registry.resolveActive()).rejects.toThrow(
      /no longer matches/u,
    );
  });

  it("recovers a previous pointer left in the Windows replacement window", async () => {
    const { root, registry } = await fixture();
    await registry.register(endpoint("instance-1", "release-1", "a"));
    await registry.activate("instance-1", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: null,
    });

    const pointer = join(root, "active-runtime.json");
    const backup = join(root, ".active-runtime.json.interrupted.bak");
    await copyFile(pointer, backup);
    await rm(pointer);

    await expect(registry.readPointer()).resolves.toMatchObject({
      generation: 1,
      active: { instanceId: "instance-1" },
    });
  });

  it("prevents removal of the active and rollback endpoints", async () => {
    const { registry } = await fixture();
    for (const [instanceId, releaseId, marker] of [
      ["instance-1", "release-1", "a"],
      ["instance-2", "release-2", "b"],
      ["instance-3", "release-3", "c"],
    ] as const) {
      await registry.register(endpoint(instanceId, releaseId, marker));
    }
    await registry.activate("instance-1", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: null,
    });
    await registry.activate("instance-2", {
      checkpointId: "checkpoint-2",
      fencingToken: "fence-2",
      expectedGeneration: 1,
    });

    await expect(registry.remove("instance-1")).rejects.toThrow(
      /may not be removed/u,
    );
    await expect(registry.remove("instance-2")).rejects.toThrow(
      /may not be removed/u,
    );
    await expect(registry.remove("instance-3")).resolves.toBeUndefined();
  });

  it("rejects unknown fields, malformed identities, and noncanonical digests", async () => {
    const { registry } = await fixture();
    await expect(
      registry.register({
        ...endpoint("instance-1", "release-1", "a"),
        manifestSha256: "A".repeat(64),
      }),
    ).rejects.toThrow(/SHA-256/u);
    await expect(
      registry.register({
        ...endpoint("../escape", "release-1", "a"),
      }),
    ).rejects.toThrow(/invalid/u);
    await expect(
      registry.register({
        ...endpoint("instance-1", "release-1", "a"),
        unexpected: true,
      } as RuntimeEndpointRecord),
    ).rejects.toThrow(/unsupported fields/u);
  });
});
