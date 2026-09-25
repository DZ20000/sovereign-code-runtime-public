import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireRendererReleaseLease,
  completeRendererReleaseLease,
  readLatestRendererState,
  verifyRendererRelease,
} from "../../scripts/renderer-release-guard.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const STATE_FILE_PATTERN = /^revision-(\d+)\.json$/u;
const roots: string[] = [];

interface ReleaseReference {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: "development";
  readonly manifestSha256: string;
}

interface StateOptions {
  readonly activeRelease: ReleaseReference | null;
  readonly highestReleaseSequence: number;
  readonly lastKnownGoodRelease?: ReleaseReference | null;
  readonly lastFailure?: string | null;
  readonly previousStateSha256?: string | null;
  readonly updatedAtUnixMs?: number;
}

function release(
  releaseId: string,
  releaseSequence: number,
  manifestSha256 = "c".repeat(64),
): ReleaseReference {
  return {
    releaseId,
    releaseSequence,
    version: `0.1.${releaseSequence}`,
    channel: "development",
    manifestSha256,
  };
}

function revisionName(revision: number): string {
  return `revision-${String(revision).padStart(20, "0")}.json`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendState(
  stateRoot: string,
  options: StateOptions,
): Promise<string> {
  const stateDirectory = path.join(stateRoot, "state");
  await mkdir(stateDirectory, { recursive: true });
  const existing = (await readdir(stateDirectory))
    .filter((name) => STATE_FILE_PATTERN.test(name))
    .sort();
  const revision = existing.length + 1;
  const previousName = existing.at(-1) ?? null;
  const previousStateSha256 =
    options.previousStateSha256 !== undefined
      ? options.previousStateSha256
      : previousName === null
        ? null
        : createHash("sha256")
            .update(await readFile(path.join(stateDirectory, previousName)))
            .digest("hex");
  const filePath = path.join(stateDirectory, revisionName(revision));
  await writeJson(filePath, {
    schemaVersion: "scr.renderer-state/v1",
    storageRevision: revision,
    previousStateSha256,
    highestReleaseSequence: options.highestReleaseSequence,
    activeRelease: options.activeRelease,
    lastKnownGoodRelease: options.lastKnownGoodRelease ?? null,
    lastFailure: options.lastFailure ?? null,
    updatedAtUnixMs: options.updatedAtUnixMs ?? revision,
  });
  return filePath;
}

async function candidate(
  stateRoot: string,
  releaseId: string,
  releaseSequence: number,
): Promise<string> {
  const directory = path.join(stateRoot, "inbox", releaseId);
  await writeJson(path.join(directory, "envelope.json"), {
    schemaVersion: "scr.renderer-release-signature/v1",
    algorithm: "ed25519",
    keyId: "test-key",
    manifestSha256: "b".repeat(64),
    signature: "test-signature",
    manifest: {
      schemaVersion: "scr.renderer-release/v1",
      releaseId,
      releaseSequence,
      version: `0.1.${releaseSequence}`,
      channel: "development",
      createdAt: "2026-08-28T00:00:00.000Z",
      entrypoint: "index.html",
      totalBytes: 1,
      components: [],
      compatibility: {
        minimumShellVersion: "0.1.0",
        maximumShellVersion: null,
        bridgeApiVersion: 1,
      },
    },
  });
  return directory;
}

async function fixture(
  active: "custom" | "built-in" = "custom",
): Promise<string> {
  const stateRoot = await mkdtemp(
    path.join(os.tmpdir(), "renderer-release-guard-"),
  );
  roots.push(stateRoot);
  const activeRelease =
    active === "custom" ? release("active-10", 10) : null;
  await appendState(stateRoot, {
    activeRelease,
    highestReleaseSequence: 10,
  });
  if (activeRelease !== null) {
    await candidate(stateRoot, activeRelease.releaseId, activeRelease.releaseSequence);
    await mkdir(path.join(stateRoot, "slots", activeRelease.releaseId), {
      recursive: true,
    });
  }
  await candidate(stateRoot, "old-5", 5);
  await candidate(stateRoot, "target-20", 20);
  return stateRoot;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Renderer release guard", () => {
  it("acquires a provenance-bound lease and reversibly quarantines older candidates", async () => {
    const stateRoot = await fixture();
    const result = await acquireRendererReleaseLease({
      stateRoot,
      releaseId: "target-20",
      originTaskId: "task-123",
      sourceCommit: SOURCE_COMMIT,
      ownerPrincipal: "test-agent",
      shellPid: 42,
      now: "2026-08-28T10:00:00.000Z",
    });

    expect(result.lease).toMatchObject({
      status: "held",
      originTaskId: "task-123",
      sourceCommit: SOURCE_COMMIT,
      targetReleaseId: "target-20",
      targetReleaseSequence: 20,
      previousActiveReleaseId: "active-10",
      previousActiveSequence: 10,
      shellPid: 42,
    });
    expect(result.quarantined.map((entry) => entry.releaseId)).toEqual([
      "old-5",
    ]);
    await expect(
      readFile(
        path.join(stateRoot, "inbox", "target-20", "envelope.json"),
        "utf8",
      ),
    ).resolves.toContain("target-20");
    await expect(
      readFile(
        path.join(stateRoot, "inbox", "active-10", "envelope.json"),
        "utf8",
      ),
    ).resolves.toContain("active-10");
    await expect(
      readFile(
        path.join(stateRoot, "inbox", "old-5", "envelope.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(result.provenancePath, "utf8")).resolves.toContain(
      "task-123",
    );
    await expect(
      readFile(
        path.join(result.quarantineRoot!, "quarantine-receipt.json"),
        "utf8",
      ),
    ).resolves.toContain("old-5");
  });

  it("acquires from a verified built-in state and records the previous active release as null", async () => {
    const stateRoot = await fixture("built-in");
    const result = await acquireRendererReleaseLease({
      stateRoot,
      releaseId: "target-20",
      originTaskId: "task-built-in",
      sourceCommit: SOURCE_COMMIT,
      ownerPrincipal: "test-agent",
      shellPid: 42,
      now: "2026-08-28T10:00:00.000Z",
    });

    expect(result).toMatchObject({
      stateRevision: 1,
      lease: {
        status: "held",
        targetReleaseId: "target-20",
        targetReleaseSequence: 20,
        previousActiveReleaseId: null,
        previousActiveSequence: null,
      },
    });
    expect(result.quarantined.map((entry) => entry.releaseId)).toEqual([
      "old-5",
    ]);
    const persistedLease = JSON.parse(await readFile(result.leasePath, "utf8"));
    expect(persistedLease).toMatchObject({
      previousActiveReleaseId: null,
      previousActiveSequence: null,
    });
    const receipt = JSON.parse(
      await readFile(
        path.join(result.quarantineRoot!, "quarantine-receipt.json"),
        "utf8",
      ),
    );
    expect(receipt.activeReleaseId).toBeNull();
  });

  it("uses the journal sequence floor for custom and built-in active states", async () => {
    for (const active of ["custom", "built-in"] as const) {
      const stateRoot = await fixture(active);
      await candidate(stateRoot, "stale-10", 10);
      await expect(
        acquireRendererReleaseLease({
          stateRoot,
          releaseId: "stale-10",
          originTaskId: "task-123",
          sourceCommit: SOURCE_COMMIT,
          ownerPrincipal: "test-agent",
          shellPid: 42,
        }),
      ).rejects.toThrow(
        "Candidate sequence 10 must be newer than highest accepted sequence 10.",
      );
    }
  });

  it("rejects newer competing candidates and invalid source provenance", async () => {
    const newerRoot = await fixture();
    await candidate(newerRoot, "newer-30", 30);
    await expect(
      acquireRendererReleaseLease({
        stateRoot: newerRoot,
        releaseId: "target-20",
        originTaskId: "task-123",
        sourceCommit: SOURCE_COMMIT,
        ownerPrincipal: "test-agent",
        shellPid: 42,
      }),
    ).rejects.toThrow("A newer Renderer candidate exists");

    const provenanceRoot = await fixture();
    await expect(
      acquireRendererReleaseLease({
        stateRoot: provenanceRoot,
        releaseId: "target-20",
        originTaskId: "task-123",
        sourceCommit: "dirty-worktree",
        ownerPrincipal: "test-agent",
        shellPid: 42,
      }),
    ).rejects.toThrow("sourceCommit has an invalid format");
  });

  it("rejects malformed, inconsistent and incomplete state journals", async () => {
    const inconsistentRoot = await fixture("built-in");
    await writeJson(
      path.join(inconsistentRoot, "state", revisionName(1)),
      {
        schemaVersion: "scr.renderer-state/v1",
        storageRevision: 1,
        previousStateSha256: null,
        highestReleaseSequence: 10,
        activeRelease: null,
        lastKnownGoodRelease: release("active-10", 10),
        lastFailure: null,
        updatedAtUnixMs: 1,
      },
    );
    await expect(
      acquireRendererReleaseLease({
        stateRoot: inconsistentRoot,
        releaseId: "target-20",
        originTaskId: "task-123",
        sourceCommit: SOURCE_COMMIT,
        ownerPrincipal: "test-agent",
        shellPid: 42,
      }),
    ).rejects.toThrow("cannot retain a custom rollback release");

    const brokenChainRoot = await fixture();
    await appendState(brokenChainRoot, {
      activeRelease: release("active-10", 10),
      highestReleaseSequence: 10,
      previousStateSha256: "0".repeat(64),
    });
    await expect(
      acquireRendererReleaseLease({
        stateRoot: brokenChainRoot,
        releaseId: "target-20",
        originTaskId: "task-123",
        sourceCommit: SOURCE_COMMIT,
        ownerPrincipal: "test-agent",
        shellPid: 42,
      }),
    ).rejects.toThrow("hash chain is invalid");

    const pendingRoot = await fixture();
    await writeFile(
      path.join(pendingRoot, "state", ".pending-revision.tmp"),
      "partial",
      "utf8",
    );
    await expect(
      acquireRendererReleaseLease({
        stateRoot: pendingRoot,
        releaseId: "target-20",
        originTaskId: "task-123",
        sourceCommit: SOURCE_COMMIT,
        ownerPrincipal: "test-agent",
        shellPid: 42,
      }),
    ).rejects.toThrow("state directory contains an unexpected entry");
  });

  it("rejects candidate paths outside the managed inbox", async () => {
    const stateRoot = await fixture();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "renderer-release-outside-"),
    );
    roots.push(outside);

    await expect(
      acquireRendererReleaseLease({
        stateRoot,
        candidateDirectory: outside,
        originTaskId: "task-123",
        sourceCommit: SOURCE_COMMIT,
        ownerPrincipal: "test-agent",
        shellPid: 42,
      }),
    ).rejects.toThrow("candidateDirectory must be a direct child");
  });

  it("fails closed while another non-expired release lease is held", async () => {
    const stateRoot = await fixture();
    await acquireRendererReleaseLease({
      stateRoot,
      releaseId: "target-20",
      originTaskId: "task-123",
      sourceCommit: SOURCE_COMMIT,
      ownerPrincipal: "first-agent",
      shellPid: 42,
      now: "2026-08-28T10:00:00.000Z",
    });
    await expect(
      acquireRendererReleaseLease({
        stateRoot,
        releaseId: "target-20",
        originTaskId: "task-456",
        sourceCommit: SOURCE_COMMIT,
        ownerPrincipal: "second-agent",
        shellPid: 42,
        now: "2026-08-28T10:01:00.000Z",
      }),
    ).rejects.toThrow("already held by first-agent");
  });

  it("verifies the durable active slot and lastFailure before completing the lease", async () => {
    const stateRoot = await fixture();
    const acquired = await acquireRendererReleaseLease({
      stateRoot,
      releaseId: "target-20",
      originTaskId: "task-123",
      sourceCommit: SOURCE_COMMIT,
      ownerPrincipal: "test-agent",
      shellPid: 42,
    });
    await expect(
      completeRendererReleaseLease({
        stateRoot,
        leaseId: acquired.lease.leaseId,
        status: "completed",
        shellPid: 42,
        now: "2026-08-28T10:05:00.000Z",
      }),
    ).rejects.toThrow("Active Renderer is active-10, not target-20");

    const targetRelease = release("target-20", 20, "b".repeat(64));
    const previousRelease = release("active-10", 10);
    await appendState(stateRoot, {
      activeRelease: targetRelease,
      lastKnownGoodRelease: previousRelease,
      highestReleaseSequence: 20,
    });
    await expect(
      completeRendererReleaseLease({
        stateRoot,
        leaseId: acquired.lease.leaseId,
        status: "completed",
        shellPid: 42,
      }),
    ).rejects.toThrow("Active Renderer slot is missing");

    await mkdir(path.join(stateRoot, "slots", "target-20"), {
      recursive: true,
    });
    await appendState(stateRoot, {
      activeRelease: targetRelease,
      lastKnownGoodRelease: previousRelease,
      highestReleaseSequence: 20,
      lastFailure: "activation-failed",
    });
    await expect(
      verifyRendererRelease({
        stateRoot,
        releaseId: "target-20",
        releaseSequence: 20,
      }),
    ).rejects.toThrow("state reports a lastFailure");

    await appendState(stateRoot, {
      activeRelease: targetRelease,
      lastKnownGoodRelease: previousRelease,
      highestReleaseSequence: 20,
    });
    await expect(
      verifyRendererRelease({
        stateRoot,
        releaseId: "target-20",
        releaseSequence: 20,
      }),
    ).resolves.toMatchObject({
      activeRelease: { releaseId: "target-20" },
    });

    await expect(
      completeRendererReleaseLease({
        stateRoot,
        leaseId: acquired.lease.leaseId,
        status: "completed",
        shellPid: 43,
        now: "2026-08-28T10:10:00.000Z",
      }),
    ).rejects.toThrow("Sovereign Shell PID changed");

    await expect(
      completeRendererReleaseLease({
        stateRoot,
        leaseId: acquired.lease.leaseId,
        status: "completed",
        shellPid: 42,
        now: "2026-08-28T10:10:00.000Z",
        result: { shellPidStable: true },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      result: { shellPidStable: true },
    });
  });

  it("preserves a failed built-in lease as an explicit audit record", async () => {
    const stateRoot = await fixture("built-in");
    const acquired = await acquireRendererReleaseLease({
      stateRoot,
      releaseId: "target-20",
      originTaskId: "task-built-in",
      sourceCommit: SOURCE_COMMIT,
      ownerPrincipal: "test-agent",
      shellPid: 42,
      quarantineOlderCandidates: false,
    });
    const failed = await completeRendererReleaseLease({
      stateRoot,
      leaseId: acquired.lease.leaseId,
      status: "failed",
      now: "2026-08-28T10:05:00.000Z",
      result: { code: "PREFLIGHT_FAILED" },
    });

    expect(failed).toMatchObject({
      status: "failed",
      previousActiveReleaseId: null,
      previousActiveSequence: null,
      result: { code: "PREFLIGHT_FAILED" },
    });
    await expect(readFile(acquired.leasePath, "utf8")).resolves.toContain(
      '"status": "failed"',
    );
  });

  it("returns the latest state only after verifying the contiguous journal", async () => {
    const stateRoot = await fixture();
    await appendState(stateRoot, {
      activeRelease: release("latest-100", 100),
      lastKnownGoodRelease: release("active-10", 10),
      highestReleaseSequence: 100,
    });

    await expect(readLatestRendererState(stateRoot)).resolves.toMatchObject({
      revision: 2,
      state: {
        storageRevision: 2,
        activeRelease: { releaseId: "latest-100", releaseSequence: 100 },
        highestReleaseSequence: 100,
      },
    });
  });
});
