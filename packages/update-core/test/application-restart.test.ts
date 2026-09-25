import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApplicationRestartBusyError,
  ApplicationRestartCoordinator,
  type ApplicationRestartAdapter,
  type ApplicationRestartCandidate,
  type ApplicationRestartContext,
  type ApplicationRestartRequest,
  type ApplicationRestartSafePoint,
} from "../src/application-restart.js";
import {
  RestartJournal,
  type RestartCheckpointReference,
} from "../src/restart-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

const candidate: ApplicationRestartCandidate = {
  releaseId: "release-2",
  directory: "candidate/release-2",
  manifestSha256: "a".repeat(64),
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-application-restart-"));
  roots.push(root);
  let clock = 1_000;
  const journal = new RestartJournal({
    rootDirectory: root,
    now: () => clock++,
  });
  const adapter = new FakeRestartAdapter();
  const coordinator = new ApplicationRestartCoordinator({
    journal,
    adapter,
    now: () => clock++,
    randomId: () => "restart-fixed-1",
  });
  return { root, journal, adapter, coordinator };
}

class FakeRestartAdapter implements ApplicationRestartAdapter {
  readonly order: string[] = [];
  readonly requests: ApplicationRestartRequest[] = [];
  failAt: string | null = null;
  safePoint: ApplicationRestartSafePoint = {
    consequentialInFlight: 0,
    unknownOutcomes: 0,
  };
  checkpointValue: RestartCheckpointReference = {
    checkpointId: "checkpoint-1",
    checkpointSha256: "b".repeat(64),
    fencingToken: "fence-1",
  };
  restartGate: Promise<void> | null = null;

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async verifyCandidate(
    value: ApplicationRestartCandidate,
    _context: ApplicationRestartContext,
  ): Promise<void> {
    this.order.push(`verify:${value.releaseId}`);
    this.#fail("verify");
  }

  async waitForSafePoint(
    releaseId: string,
    _context: ApplicationRestartContext,
  ): Promise<ApplicationRestartSafePoint> {
    this.order.push(`safe-point:${releaseId}`);
    this.#fail("safe-point");
    return this.safePoint;
  }

  async checkpoint(
    releaseId: string,
    _context: ApplicationRestartContext,
  ): Promise<RestartCheckpointReference> {
    this.order.push(`checkpoint:${releaseId}`);
    this.#fail("checkpoint");
    return this.checkpointValue;
  }

  async requestRestart(
    request: ApplicationRestartRequest,
    _context: ApplicationRestartContext,
  ): Promise<void> {
    this.order.push(
      `restart:${request.targetReleaseId}:${request.rollback ? "rollback" : "candidate"}`,
    );
    this.requests.push(request);
    this.#fail(request.rollback ? "request-rollback" : "request-restart");
    if (this.restartGate !== null) await this.restartGate;
  }

  async waitUntilHealthy(
    releaseId: string,
    _restartId: string,
    _context: ApplicationRestartContext,
  ): Promise<void> {
    this.order.push(`health:${releaseId}`);
    this.#fail(`health:${releaseId}`);
  }

  async restoreCheckpoint(
    checkpoint: RestartCheckpointReference,
    _context: ApplicationRestartContext,
  ): Promise<void> {
    this.order.push(`restore:${checkpoint.checkpointId}`);
    this.#fail("restore");
  }

  async commitCandidate(
    releaseId: string,
    checkpoint: RestartCheckpointReference,
    _context: ApplicationRestartContext,
  ): Promise<void> {
    this.order.push(`commit:${releaseId}:${checkpoint.checkpointId}`);
    this.#fail("commit");
  }
}

async function prepare(
  coordinator: ApplicationRestartCoordinator,
): Promise<void> {
  await coordinator.prepare({
    updateId: "restart-update-1",
    currentReleaseId: "release-1",
    candidate,
  });
}

describe("ApplicationRestartCoordinator", () => {
  it("verifies, reaches a safe point, checkpoints, journals, and requests the candidate restart", async () => {
    const { journal, adapter, coordinator } = await fixture();

    const receipt = await coordinator.prepare({
      updateId: "restart-update-1",
      currentReleaseId: "release-1",
      candidate,
    });

    expect(receipt).toMatchObject({
      updateId: "restart-update-1",
      restartId: "restart-fixed-1",
      currentReleaseId: "release-1",
      candidateReleaseId: "release-2",
      checkpointId: "checkpoint-1",
      phase: "restart-requested",
    });
    expect(adapter.order).toEqual([
      "verify:release-2",
      "safe-point:release-1",
      "checkpoint:release-1",
      "restart:release-2:candidate",
    ]);
    await expect(journal.openIntent()).resolves.toMatchObject({
      phase: "restart-requested",
      restartId: "restart-fixed-1",
      checkpointSha256: "b".repeat(64),
    });
  });

  it("commits after the candidate process starts healthy and restores its checkpoint", async () => {
    const { journal, adapter, coordinator } = await fixture();
    await prepare(coordinator);
    adapter.order.length = 0;

    const receipt = await coordinator.resume("release-2");

    expect(receipt).toMatchObject({
      outcome: "committed",
      phase: "committed",
      runningReleaseId: "release-2",
      failureReason: null,
    });
    expect(adapter.order).toEqual([
      "health:release-2",
      "restore:checkpoint-1",
      "commit:release-2:checkpoint-1",
    ]);
    expect((await journal.readAll()).map((entry) => entry.phase)).toEqual([
      "prepared",
      "restart-requested",
      "candidate-started",
      "candidate-healthy",
      "committed",
    ]);
    await expect(journal.openIntent()).resolves.toBeNull();
  });

  it("requests rollback after candidate health failure, then closes when the previous release returns", async () => {
    const { journal, adapter, coordinator } = await fixture();
    await prepare(coordinator);
    adapter.order.length = 0;
    adapter.failAt = "health:release-2";

    const requested = await coordinator.resume("release-2");

    expect(requested).toMatchObject({
      outcome: "rollback-requested",
      phase: "rollback-requested",
      runningReleaseId: "release-2",
      failureReason: "health:release-2 failed",
    });
    expect(adapter.order).toEqual([
      "health:release-2",
      "restart:release-1:rollback",
    ]);
    await expect(journal.openIntent()).resolves.toMatchObject({
      phase: "rollback-requested",
    });

    adapter.failAt = null;
    adapter.order.length = 0;
    const rolledBack = await coordinator.resume("release-1");
    expect(rolledBack).toMatchObject({
      outcome: "rolled-back",
      phase: "rolled-back",
      runningReleaseId: "release-1",
    });
    expect(adapter.order).toEqual(["health:release-1", "restore:checkpoint-1"]);
    await expect(journal.openIntent()).resolves.toBeNull();
  });

  it("treats the previous release returning before candidate activation as a bounded rollback", async () => {
    const { journal, adapter, coordinator } = await fixture();
    await prepare(coordinator);
    adapter.order.length = 0;

    const receipt = await coordinator.resume("release-1");

    expect(receipt).toMatchObject({
      outcome: "rolled-back",
      runningReleaseId: "release-1",
    });
    expect(adapter.order).toEqual(["health:release-1", "restore:checkpoint-1"]);
    expect((await journal.readAll()).at(-1)?.failureReason).toMatch(
      /did not become active/u,
    );
  });

  it("records restart-request failure as terminal instead of leaving an ambiguous open intent", async () => {
    const { journal, adapter, coordinator } = await fixture();
    adapter.failAt = "request-restart";

    await expect(
      coordinator.prepare({
        updateId: "restart-update-1",
        currentReleaseId: "release-1",
        candidate,
      }),
    ).rejects.toThrow(/request-restart failed/u);
    await expect(journal.openIntent()).resolves.toBeNull();
    expect((await journal.readAll()).at(-1)?.phase).toBe("failed");
  });

  it("does not persist an intent before safe point and checkpoint validation succeeds", async () => {
    const first = await fixture();
    first.adapter.safePoint = {
      consequentialInFlight: 1,
      unknownOutcomes: 0,
    };
    await expect(
      first.coordinator.prepare({
        updateId: "restart-update-1",
        currentReleaseId: "release-1",
        candidate,
      }),
    ).rejects.toThrow(/safe point/u);
    await expect(first.journal.readAll()).resolves.toEqual([]);

    const second = await fixture();
    second.adapter.checkpointValue = {
      checkpointId: "checkpoint-1",
      checkpointSha256: "not-a-digest",
      fencingToken: "fence-1",
    };
    await expect(
      second.coordinator.prepare({
        updateId: "restart-update-1",
        currentReleaseId: "release-1",
        candidate,
      }),
    ).rejects.toThrow(/checkpoint digest/u);
    await expect(second.journal.readAll()).resolves.toEqual([]);
  });

  it("fails an intent when an unrelated release starts", async () => {
    const { journal, coordinator } = await fixture();
    await prepare(coordinator);

    const receipt = await coordinator.resume("release-unrelated");

    expect(receipt).toMatchObject({
      outcome: "failed",
      runningReleaseId: "release-unrelated",
      failureReason: expect.stringMatching(/does not match restart intent/u),
    });
    await expect(journal.openIntent()).resolves.toBeNull();
  });

  it("returns null when no restart intent is open", async () => {
    const { coordinator } = await fixture();
    await expect(coordinator.resume("release-1")).resolves.toBeNull();
  });

  it("rejects concurrent operations rather than starting a second restart transaction", async () => {
    const { adapter, coordinator } = await fixture();
    let releaseRestart!: () => void;
    adapter.restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    const first = coordinator.prepare({
      updateId: "restart-update-1",
      currentReleaseId: "release-1",
      candidate,
    });
    for (let attempt = 0; attempt < 20 && !coordinator.busy; attempt += 1) {
      await Promise.resolve();
    }

    expect(coordinator.busy).toBe(true);
    await expect(coordinator.resume("release-1")).rejects.toBeInstanceOf(
      ApplicationRestartBusyError,
    );
    releaseRestart();
    await expect(first).resolves.toMatchObject({ phase: "restart-requested" });
  });
});
