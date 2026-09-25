import {
  access,
  link,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeSupervisorState,
  reduceRuntimeSupervisorState,
  type RuntimeSlotIdentity,
} from "../src/runtime-supervisor-state.js";
import {
  RuntimeSupervisorStore,
  RuntimeSupervisorStoreError,
} from "../src/runtime-supervisor-store.js";

const cleanup: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = resolve(
    tmpdir(),
    `scr-runtime-supervisor-${label}-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  await mkdir(path, { recursive: true });
  cleanup.push(path);
  return path;
}

function runtime(options: {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly runtimeGeneration: number;
  readonly processId: number;
  readonly port: number;
}): RuntimeSlotIdentity {
  return {
    releaseId: options.releaseId,
    releaseSequence: options.releaseSequence,
    version: `1.${options.releaseSequence}.0`,
    instanceId: `${options.releaseId}-instance`,
    runtimeGeneration: options.runtimeGeneration,
    endpoint: `http://127.0.0.1:${options.port}/mcp`,
    manifestDigest: String(options.releaseSequence % 10).repeat(64),
    processId: options.processId,
    startedAt: "2026-08-23T00:00:00.000Z",
  };
}

const active = runtime({
  releaseId: "release-20",
  releaseSequence: 20,
  runtimeGeneration: 60,
  processId: 100,
  port: 44000,
});
const candidate = runtime({
  releaseId: "release-21",
  releaseSequence: 21,
  runtimeGeneration: 61,
  processId: 200,
  port: 45000,
});

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});

async function expectStoreError(
  operation: Promise<unknown>,
  code: RuntimeSupervisorStoreError["code"],
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected RuntimeSupervisorStoreError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeSupervisorStoreError);
    expect((error as RuntimeSupervisorStoreError).code).toBe(code);
  }
}

describe("RuntimeSupervisorStore", () => {
  it("initializes and appends a contiguous SHA-256 state chain", async () => {
    const root = await temporaryDirectory("chain");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    const initial = createRuntimeSupervisorState(
      active,
      "2026-08-23T00:00:00.000Z",
    );
    const first = await store.initialize(initial);
    expect(first).toMatchObject({
      revision: 1,
      entrySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      state: { phase: "stable", active },
    });

    const staged = reduceRuntimeSupervisorState(first.state, {
      type: "stage-candidate",
      at: "2026-08-23T00:01:00.000Z",
      transitionId: "transition-store-0001",
      candidate,
    });
    const second = await store.append(staged, first);
    expect(second).toMatchObject({
      revision: 2,
      state: {
        phase: "candidate-starting",
        epoch: 2,
        candidate,
      },
    });
    expect(second.entrySha256).not.toBe(first.entrySha256);
    await expect(store.load()).resolves.toEqual(second);

    const entry = JSON.parse(
      await readFile(
        join(root, "entries", "entry-0000000000000002.json"),
        "utf8",
      ),
    ) as { previousEntrySha256: string };
    expect(entry.previousEntrySha256).toBe(first.entrySha256);
  });

  it("uses revision and digest CAS so only one concurrent writer wins", async () => {
    const root = await temporaryDirectory("cas");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    const first = await store.initialize(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    const stagedA = reduceRuntimeSupervisorState(first.state, {
      type: "stage-candidate",
      at: "2026-08-23T00:01:00.000Z",
      transitionId: "transition-store-a",
      candidate,
    });
    const alternateCandidate = runtime({
      releaseId: "release-22",
      releaseSequence: 22,
      runtimeGeneration: 62,
      processId: 300,
      port: 46000,
    });
    const stagedB = reduceRuntimeSupervisorState(first.state, {
      type: "stage-candidate",
      at: "2026-08-23T00:01:00.000Z",
      transitionId: "transition-store-b",
      candidate: alternateCandidate,
    });

    const results = await Promise.allSettled([
      store.append(stagedA, first),
      store.append(stagedB, first),
    ]);
    const outcomeSummary = results.map((result) => {
      if (result.status === "fulfilled") {
        return { status: result.status, revision: result.value.revision };
      }
      const reason = result.reason as Error & {
        readonly code?: string;
        readonly cause?: Error & { readonly code?: string };
      };
      return {
        status: result.status,
        code: reason.code,
        message: reason.message,
        causeCode: reason.cause?.code,
        causeMessage: reason.cause?.message,
      };
    });
    expect(
      results.filter((result) => result.status === "fulfilled"),
      JSON.stringify(outcomeSummary),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(RuntimeSupervisorStoreError);
    expect((rejected?.reason as RuntimeSupervisorStoreError).code).toBe(
      "CONFLICT",
    );
    const head = await store.load();
    expect(head.revision).toBe(2);
    expect([candidate.releaseId, alternateCandidate.releaseId]).toContain(
      head.state.candidate?.releaseId,
    );
  });

  it("rejects stale expectations, state regressions, and unchanged state", async () => {
    const root = await temporaryDirectory("conflicts");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    const first = await store.initialize(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    await expectStoreError(store.append(first.state, first), "CONFLICT");

    const staged = reduceRuntimeSupervisorState(first.state, {
      type: "stage-candidate",
      at: "2026-08-23T00:01:00.000Z",
      transitionId: "transition-store-0002",
      candidate,
    });
    const second = await store.append(staged, first);
    await expectStoreError(
      store.append(
        {
          ...second.state,
          epoch: 1,
        },
        second,
      ),
      "CONFLICT",
    );
    await expectStoreError(store.append(staged, first), "CONFLICT");
  });

  it("fails closed for unknown inventory and broken hash chains", async () => {
    const root = await temporaryDirectory("corruption");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    const first = await store.initialize(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    const staged = reduceRuntimeSupervisorState(first.state, {
      type: "stage-candidate",
      at: "2026-08-23T00:01:00.000Z",
      transitionId: "transition-store-0003",
      candidate,
    });
    await store.append(staged, first);

    await writeFile(join(root, "entries", "unexpected.txt"), "unsafe", "utf8");
    await expectStoreError(store.load(), "INVALID_INVENTORY");
    await rm(join(root, "entries", "unexpected.txt"), { force: true });

    const secondPath = join(root, "entries", "entry-0000000000000002.json");
    const parsed = JSON.parse(await readFile(secondPath, "utf8")) as {
      previousEntrySha256: string;
    };
    parsed.previousEntrySha256 = "f".repeat(64);
    await writeFile(secondPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await expectStoreError(store.load(), "LEDGER_CORRUPT");
  });

  it("waits for a transient publication hard link before reading", async () => {
    const root = await temporaryDirectory("transient-hard-link");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    const expected = await store.initialize(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    const entryPath = join(root, "entries", "entry-0000000000000001.json");
    const transientPath = join(root, "transient-publication-link.json");
    await link(entryPath, transientPath);
    const releaseLink = new Promise<void>((resolveRelease, rejectRelease) => {
      setTimeout(() => {
        void rm(transientPath, { force: true }).then(
          resolveRelease,
          rejectRelease,
        );
      }, 25);
    });

    await expect(store.load()).resolves.toEqual(expected);
    await releaseLink;
  });

  it("rejects shared hard-linked entries and cleans bounded abandoned pending files", async () => {
    const root = await temporaryDirectory("inventory");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    await store.initialize(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    const entryPath = join(root, "entries", "entry-0000000000000001.json");
    await link(entryPath, join(root, "entry-copy.json"));
    await expectStoreError(store.load(), "LEDGER_CORRUPT");
    await rm(join(root, "entry-copy.json"), { force: true });

    const freshRoot = await temporaryDirectory("pending");
    const freshStore = new RuntimeSupervisorStore({ directoryPath: freshRoot });
    await freshStore.initialize(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    const pendingPath = join(
      freshRoot,
      "entries",
      ".pending-00000000-0000-4000-8000-000000000000.json",
    );
    await writeFile(pendingPath, "{}", "utf8");
    await expect(freshStore.load()).resolves.toMatchObject({ revision: 1 });
    await expect(access(pendingPath)).resolves.toBeUndefined();

    const abandonedAt = new Date(Date.now() - 60 * 60 * 1_000);
    await utimes(pendingPath, abandonedAt, abandonedAt);
    await expect(freshStore.load()).resolves.toMatchObject({ revision: 1 });
    await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an absolute local ledger path and reports an empty ledger", async () => {
    expect(
      () =>
        new RuntimeSupervisorStore({
          directoryPath: "relative/runtime-ledger",
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
    const root = await temporaryDirectory("empty");
    const store = new RuntimeSupervisorStore({ directoryPath: root });
    await expectStoreError(store.load(), "LEDGER_EMPTY");
  });
});
