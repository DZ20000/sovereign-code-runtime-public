import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BootstrapUpdateStateStore,
  BootstrapUpdateStateStoreError,
  createUpdateState,
  reduceUpdateState,
  type BootstrapUpdateStateStoreOptions,
  type UpdateReleaseRef,
  type UpdateState,
} from "../src/index.js";

const cleanupPaths: string[] = [];
const active: UpdateReleaseRef = {
  releaseId: "release-0001",
  releaseSequence: 1,
  version: "0.1.0",
};
const candidate: UpdateReleaseRef = {
  releaseId: "release-0002",
  releaseSequence: 2,
  version: "0.2.0",
};
const alternateCandidate: UpdateReleaseRef = {
  releaseId: "release-0002-alt",
  releaseSequence: 2,
  version: "0.2.0-alt",
};

function initialState(): UpdateState {
  return createUpdateState(active, 0);
}

function stagedState(nextCandidate = candidate): UpdateState {
  return reduceUpdateState(initialState(), {
    type: "stage-candidate",
    at: 10,
    candidate: nextCandidate,
  }).state;
}

function preflightState(): UpdateState {
  const staged = stagedState();
  return reduceUpdateState(staged, {
    type: "start-preflight",
    at: 20,
    generation: staged.generation,
  }).state;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scr-update-state-store-"));
  cleanupPaths.push(root);
  return root;
}

function createStore(
  root: string,
  overrides: Partial<BootstrapUpdateStateStoreOptions> = {},
): BootstrapUpdateStateStore {
  return new BootstrapUpdateStateStore({
    directoryPath: join(root, "bootstrap-state"),
    ...overrides,
  });
}

async function expectStoreCode(
  operation: () => Promise<unknown>,
  code: BootstrapUpdateStateStoreError["code"],
): Promise<void> {
  try {
    await operation();
    throw new Error(`Expected BootstrapUpdateStateStoreError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapUpdateStateStoreError);
    expect((error as BootstrapUpdateStateStoreError).code).toBe(code);
  }
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bootstrap update-state store", () => {
  it("requires an absolute state-directory path", () => {
    expect(() => new BootstrapUpdateStateStore({ directoryPath: "relative/state" }))
      .toThrow(/absolute local path/u);
  });

  it("creates and reads the initial immutable revision", async () => {
    const root = await createRoot();
    const store = createStore(root);

    expect(await store.read()).toBeNull();
    const created = await store.create(initialState());
    expect(created).toMatchObject({
      storageRevision: 1,
      previousStateSha256: null,
      state: initialState(),
      fileName: "revision-0000000000000001.json",
    });
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(typeof created.directorySyncCompleted).toBe("boolean");
    expect(await store.read()).toEqual({
      storageRevision: created.storageRevision,
      previousStateSha256: created.previousStateSha256,
      state: created.state,
      sha256: created.sha256,
      bytes: created.bytes,
      fileName: created.fileName,
    });
    expect(await store.temporaryFiles()).toEqual([]);
  });

  it("publishes a chained compare-and-swap replacement", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const created = await store.create(initialState());

    const replaced = await store.replace(stagedState(), {
      storageRevision: created.storageRevision,
      sha256: created.sha256,
    });
    expect(replaced).toMatchObject({
      storageRevision: 2,
      previousStateSha256: created.sha256,
      state: stagedState(),
      fileName: "revision-0000000000000002.json",
    });
    expect((await store.read())?.sha256).toBe(replaced.sha256);
  });

  it("rejects stale or malformed replacement expectations", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const created = await store.create(initialState());
    await store.replace(stagedState(), {
      storageRevision: created.storageRevision,
      sha256: created.sha256,
    });

    await expectStoreCode(
      () => store.replace(preflightState(), {
        storageRevision: created.storageRevision,
        sha256: created.sha256,
      }),
      "STATE_CONFLICT",
    );
    await expectStoreCode(
      () => store.replace(preflightState(), {
        storageRevision: 2,
        sha256: "not-a-digest",
      }),
      "STATE_CONFLICT",
    );
  });

  it("allows only one concurrent writer for the next revision", async () => {
    const root = await createRoot();
    const firstStore = createStore(root);
    const secondStore = createStore(root);
    const created = await firstStore.create(initialState());
    const expectation = {
      storageRevision: created.storageRevision,
      sha256: created.sha256,
    };

    const results = await Promise.allSettled([
      firstStore.replace(stagedState(candidate), expectation),
      secondStore.replace(stagedState(alternateCandidate), expectation),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(BootstrapUpdateStateStoreError);
    expect((rejected[0]!.reason as BootstrapUpdateStateStoreError).code)
      .toBe("STATE_CONFLICT");
    expect((await firstStore.read())?.storageRevision).toBe(2);
  });

  it("allows only one concurrent creator for revision one", async () => {
    const root = await createRoot();
    const firstStore = createStore(root);
    const secondStore = createStore(root);

    const results = await Promise.allSettled([
      firstStore.create(initialState()),
      secondStore.create(initialState()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(BootstrapUpdateStateStoreError);
    expect(["STATE_ALREADY_EXISTS", "STATE_CONFLICT"]).toContain(
      (rejected[0]!.reason as BootstrapUpdateStateStoreError).code,
    );
  });

  it("ignores an orphaned temporary write and keeps the last revision readable", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const created = await store.create(initialState());
    const temporaryName =
      `.bootstrap-update-state-${process.pid}-${randomUUID()}.tmp`;
    await writeFile(
      join(store.directoryPath(), temporaryName),
      "{\"partial\":",
      "utf8",
    );

    expect((await store.read())?.sha256).toBe(created.sha256);
    expect(await store.temporaryFiles()).toEqual([temporaryName]);
  });

  it("fails closed for malformed, oversized, gapped, and unexpected entries", async () => {
    const malformedRoot = await createRoot();
    const malformedStore = createStore(malformedRoot);
    await malformedStore.read();
    await writeFile(
      join(malformedStore.directoryPath(), "revision-0000000000000001.json"),
      "{not-json",
      "utf8",
    );
    await expectStoreCode(() => malformedStore.read(), "STATE_CORRUPT");

    const oversizedRoot = await createRoot();
    const oversizedStore = createStore(oversizedRoot, { maximumStateBytes: 128 });
    await oversizedStore.read();
    await writeFile(
      join(oversizedStore.directoryPath(), "revision-0000000000000001.json"),
      "x".repeat(129),
      "utf8",
    );
    await expectStoreCode(() => oversizedStore.read(), "STATE_TOO_LARGE");

    const gapRoot = await createRoot();
    const gapStore = createStore(gapRoot);
    await gapStore.read();
    await writeFile(
      join(gapStore.directoryPath(), "revision-0000000000000002.json"),
      "{}",
      "utf8",
    );
    await expectStoreCode(() => gapStore.read(), "STATE_CORRUPT");

    const unexpectedRoot = await createRoot();
    const unexpectedStore = createStore(unexpectedRoot);
    await unexpectedStore.read();
    await writeFile(join(unexpectedStore.directoryPath(), "notes.txt"), "unexpected", "utf8");
    await expectStoreCode(() => unexpectedStore.read(), "STATE_CORRUPT");
  });

  it("detects revision-chain tampering", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const created = await store.create(initialState());
    await store.replace(stagedState(), {
      storageRevision: created.storageRevision,
      sha256: created.sha256,
    });
    const firstRevision = join(
      store.directoryPath(),
      "revision-0000000000000001.json",
    );
    await chmod(firstRevision, 0o600).catch(() => undefined);
    await appendFile(firstRevision, " ", "utf8");

    await expectStoreCode(() => store.read(), "STATE_CORRUPT");
  });

  it("bounds cumulative revision-chain bytes", async () => {
    const root = await createRoot();
    const seedStore = createStore(root);
    let snapshot = await seedStore.create(initialState());
    for (let index = 0; index < 12; index += 1) {
      snapshot = await seedStore.replace(initialState(), {
        storageRevision: snapshot.storageRevision,
        sha256: snapshot.sha256,
      });
    }
    expect(snapshot.bytes).toBeLessThan(4_096);

    const boundedStore = createStore(root, {
      maximumStateBytes: 4_096,
      maximumChainBytes: 4_096,
    });
    await expectStoreCode(() => boundedStore.read(), "STATE_TOO_LARGE");
  });

  it("enforces the configured revision limit before publishing", async () => {
    const root = await createRoot();
    const store = createStore(root, { maximumRevisions: 1 });
    const created = await store.create(initialState());

    await expectStoreCode(
      () => store.replace(stagedState(), {
        storageRevision: created.storageRevision,
        sha256: created.sha256,
      }),
      "STATE_REVISION_LIMIT",
    );
    expect((await store.read())?.storageRevision).toBe(1);
  });

  it("rejects a state directory that is a symbolic link or junction", async () => {
    const root = await createRoot();
    const target = join(root, "real-state");
    const linked = join(root, "linked-state");
    await mkdir(target);
    try {
      await symlink(
        target,
        linked,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS"].includes(code ?? "")) return;
      throw error;
    }
    const store = new BootstrapUpdateStateStore({ directoryPath: linked });
    await expectStoreCode(() => store.read(), "UNSAFE_STORE_PATH");
  });

  it("rejects a revision that is a symbolic link", async () => {
    const root = await createRoot();
    const store = createStore(root);
    await store.read();
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}", "utf8");
    try {
      await symlink(
        outside,
        join(store.directoryPath(), "revision-0000000000000001.json"),
        "file",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS"].includes(code ?? "")) return;
      throw error;
    }
    await expectStoreCode(() => store.read(), "UNSAFE_STORE_PATH");
  });

  it("loads interrupted state, applies pure recovery, and persists the recovery revision", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const created = await store.create(preflightState());
    const loaded = await store.read();
    expect(loaded?.state.lifecycle).toBe("preflight");

    const recovered = reduceUpdateState(loaded!.state, {
      type: "recover",
      at: 0,
      observedActiveReleaseId: active.releaseId,
    });
    expect(recovered.effect.kind).toBe("discard-candidate");
    const persisted = await store.replace(recovered.state, {
      storageRevision: loaded!.storageRevision,
      sha256: loaded!.sha256,
    });
    expect(persisted.state).toMatchObject({
      lifecycle: "idle",
      active,
      candidate: null,
      phaseStartedAt: 0,
    });
    expect(persisted.previousStateSha256).toBe(created.sha256);
  });

  it("rejects a parent path that traverses a symbolic link", async () => {
    const root = await createRoot();
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    await mkdir(realParent);
    try {
      await symlink(
        realParent,
        linkedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS"].includes(code ?? "")) return;
      throw error;
    }
    const store = new BootstrapUpdateStateStore({
      directoryPath: resolve(linkedParent, "bootstrap-state"),
    });
    await expectStoreCode(() => store.read(), "UNSAFE_STORE_PATH");
  });
});
