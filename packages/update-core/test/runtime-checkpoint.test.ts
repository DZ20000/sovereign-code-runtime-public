import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeCheckpointStore,
  type RuntimeCheckpointInput,
} from "../src/runtime-checkpoint.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scr-runtime-checkpoint-"));
  roots.push(root);
  return root;
}

function input(
  cutoverId = "cutover-1",
  epoch = 1,
  overrides: Partial<RuntimeCheckpointInput> = {},
): RuntimeCheckpointInput {
  return {
    cutoverId,
    epoch,
    sourceHost: { instanceId: "host-active", releaseId: "runtime-1" },
    candidateReleaseId: "runtime-2",
    runtimeManifestSha256: "a".repeat(64),
    taskSnapshotSha256: "b".repeat(64),
    taskCount: 3,
    lastMessageSequence: 42,
    activeRunIds: ["run-z", "run-a"],
    ...overrides,
  };
}

function store(
  directory: string,
  overrides: {
    readonly now?: () => number;
    readonly tokenFactory?: () => string;
  } = {},
): RuntimeCheckpointStore {
  return new RuntimeCheckpointStore({
    directory,
    now: overrides.now ?? (() => 1_000),
    tokenFactory:
      overrides.tokenFactory ??
      (() => "fence_abcdefghijklmnopqrstuvwxyz0123456789"),
  });
}

async function onlyFile(directory: string): Promise<string> {
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  expect(files).toHaveLength(1);
  return join(directory, files[0]!);
}

describe("RuntimeCheckpointStore", () => {
  it("prepares, adopts, and commits one durable fenced checkpoint", async () => {
    const root = await temporaryRoot();
    let now = 100;
    const checkpoints = store(root, { now: () => now++ });

    const prepared = await checkpoints.prepare(input());
    expect(prepared).toMatchObject({
      schemaVersion: "scr.runtime-cutover-checkpoint/v1",
      checkpointId: "checkpoint:cutover-1:1",
      cutoverId: "cutover-1",
      epoch: 1,
      fencingToken: "fence_abcdefghijklmnopqrstuvwxyz0123456789",
      activeRunIds: ["run-a", "run-z"],
      createdAt: 100,
    });
    expect(prepared.checkpointSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(checkpoints.status()).resolves.toMatchObject({
      active: { state: "prepared", checkpoint: prepared },
      eventCount: 1,
      checkpointCount: 1,
    });

    const adopted = await checkpoints.adopt(
      prepared.checkpointId,
      "host-candidate",
    );
    expect(adopted).toMatchObject({
      state: "adopted",
      candidateInstanceId: "host-candidate",
      latestEvent: { eventType: "adopted", sequence: 2 },
    });

    const committed = await checkpoints.commit(
      prepared.checkpointId,
      "host-candidate",
    );
    expect(committed).toMatchObject({
      state: "committed",
      candidateInstanceId: "host-candidate",
      latestEvent: { eventType: "committed", sequence: 3 },
    });
    await expect(checkpoints.status()).resolves.toMatchObject({
      active: null,
      latest: { state: "committed" },
      eventCount: 3,
      checkpointCount: 1,
    });
    await expect(
      checkpoints.commit(prepared.checkpointId, "host-candidate"),
    ).resolves.toMatchObject({ state: "committed" });
  });

  it("rolls back prepared or adopted checkpoints and then permits a new cutover", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    const first = await checkpoints.prepare(input());

    const rolledBack = await checkpoints.rollback(
      first.checkpointId,
      "candidate failed readiness\ncheck",
    );
    expect(rolledBack).toMatchObject({
      state: "rolled-back",
      latestEvent: {
        eventType: "rolled-back",
        reason: "candidate failed readiness check",
      },
    });
    expect((await checkpoints.status()).active).toBeNull();

    const second = await checkpoints.prepare(
      input("cutover-2", 2, {
        candidateReleaseId: "runtime-3",
        taskSnapshotSha256: "c".repeat(64),
      }),
    );
    await checkpoints.adopt(second.checkpointId, "host-candidate-2");
    await expect(
      checkpoints.rollback(second.checkpointId, "canary failed"),
    ).resolves.toMatchObject({
      state: "rolled-back",
      candidateInstanceId: "host-candidate-2",
    });
  });

  it("prevents a second active checkpoint and rejects divergent idempotency evidence", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    const original = input();
    const prepared = await checkpoints.prepare(original);

    await expect(checkpoints.prepare(original)).resolves.toEqual(prepared);
    await expect(
      checkpoints.prepare(
        input("cutover-1", 1, { taskSnapshotSha256: "d".repeat(64) }),
      ),
    ).rejects.toThrow(/different checkpoint evidence/u);
    await expect(checkpoints.prepare(input("cutover-2", 2))).rejects.toThrow(
      /still active/u,
    );
  });

  it("requires adoption by the same candidate before commit", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    const prepared = await checkpoints.prepare(input());

    await expect(
      checkpoints.commit(prepared.checkpointId, "host-candidate"),
    ).rejects.toThrow(/must be adopted/u);
    await checkpoints.adopt(prepared.checkpointId, "host-candidate");
    await expect(
      checkpoints.adopt(prepared.checkpointId, "other-candidate"),
    ).rejects.toThrow(/another candidate/u);
    await expect(
      checkpoints.commit(prepared.checkpointId, "other-candidate"),
    ).rejects.toThrow(/same candidate/u);
  });

  it("serializes competing prepares across store instances", async () => {
    const root = await temporaryRoot();
    const left = store(root, {
      tokenFactory: () => "left_fence_abcdefghijklmnopqrstuvwxyz012345",
    });
    const right = store(root, {
      tokenFactory: () => "right_fence_abcdefghijklmnopqrstuvwxyz01234",
    });

    const outcomes = await Promise.allSettled([
      left.prepare(input("cutover-left", 1)),
      right.prepare(input("cutover-right", 2)),
    ]);
    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === "rejected"),
    ).toHaveLength(1);
    await expect(left.status()).resolves.toMatchObject({
      active: { state: "prepared" },
      eventCount: 1,
    });
  });

  it("recovers an inert checkpoint orphan by appending its prepared event", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    const prepared = await checkpoints.prepare(input());
    const eventPath = await onlyFile(join(root, "events"));
    await rm(eventPath);

    const recoveredStore = store(root, {
      tokenFactory: () => "unused_fence_abcdefghijklmnopqrstuvwxyz0123",
    });
    await expect(recoveredStore.status()).resolves.toMatchObject({
      active: null,
      checkpointCount: 1,
      eventCount: 0,
    });
    await expect(recoveredStore.prepare(input())).resolves.toEqual(prepared);
    await expect(recoveredStore.status()).resolves.toMatchObject({
      active: { state: "prepared" },
      eventCount: 1,
    });
  });

  it("detects checkpoint and event tampering and sequence gaps", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    await checkpoints.prepare(input());
    const checkpointPath = await onlyFile(join(root, "checkpoints"));
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    await writeFile(
      checkpointPath,
      `${JSON.stringify({ ...checkpoint, taskCount: 999 })}\n`,
      "utf8",
    );
    await expect(checkpoints.status()).rejects.toThrow(
      /digest does not match/u,
    );

    const cleanRoot = await temporaryRoot();
    const clean = store(cleanRoot);
    const prepared = await clean.prepare(input());
    await clean.adopt(prepared.checkpointId, "host-candidate");
    const events = (await readdir(join(cleanRoot, "events"))).sort();
    const firstPath = join(cleanRoot, "events", events[0]!);
    const first = JSON.parse(await readFile(firstPath, "utf8"));
    await writeFile(
      firstPath,
      `${JSON.stringify({ ...first, at: 999 })}\n`,
      "utf8",
    );
    await expect(clean.status()).rejects.toThrow(/digest does not match/u);

    const gapRoot = await temporaryRoot();
    const gap = store(gapRoot);
    const gapPrepared = await gap.prepare(input());
    await gap.adopt(gapPrepared.checkpointId, "host-candidate");
    const gapEvents = (await readdir(join(gapRoot, "events"))).sort();
    await rename(
      join(gapRoot, "events", gapEvents[1]!),
      join(
        gapRoot,
        "events",
        gapEvents[1]!.replace("000000000002", "000000000003"),
      ),
    );
    await expect(gap.status()).rejects.toThrow(/not contiguous/u);
  });

  it("normalizes run IDs and rejects duplicates and invalid fencing tokens", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    await expect(
      checkpoints.prepare(
        input("duplicate-runs", 1, { activeRunIds: ["run-1", "run-1"] }),
      ),
    ).rejects.toThrow(/duplicates/u);

    const invalidToken = store(await temporaryRoot(), {
      tokenFactory: () => "short",
    });
    await expect(invalidToken.prepare(input())).rejects.toThrow(
      /token factory/u,
    );
  });

  it("will not roll back a committed checkpoint in place", async () => {
    const root = await temporaryRoot();
    const checkpoints = store(root);
    const prepared = await checkpoints.prepare(input());
    await checkpoints.adopt(prepared.checkpointId, "host-candidate");
    await checkpoints.commit(prepared.checkpointId, "host-candidate");

    await expect(
      checkpoints.rollback(prepared.checkpointId, "too late"),
    ).rejects.toThrow(/cannot be rolled back/u);
  });
});
