import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LayeredCutoverJournal } from "../src/layered-cutover-journal.js";
import {
  RendererCutoverCoordinator,
  type RendererCutoverAdapter,
  type RendererCutoverContext,
  type RendererTarget,
} from "../src/renderer-cutover.js";
import {
  RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
  RendererSlotStore,
  type RendererSlotManifest,
} from "../src/renderer-slot.js";
import {
  RuntimeCutoverCoordinator,
  type RuntimeCheckpoint,
  type RuntimeCutoverAdapter,
  type RuntimeCutoverContext,
  type RuntimeDrainReport,
  type RuntimeHostHandle,
  type RuntimeReleaseCandidate,
  type RuntimeTrafficSwitch,
} from "../src/runtime-cutover.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

class JournalRuntimeAdapter implements RuntimeCutoverAdapter {
  readonly order: string[] = [];

  async startCandidate(
    candidate: RuntimeReleaseCandidate,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    this.order.push("start");
    return { instanceId: "candidate-2", releaseId: candidate.releaseId };
  }

  async waitUntilHealthy(): Promise<void> {
    this.order.push("health");
  }

  async quiesce(): Promise<void> {
    this.order.push("quiesce");
  }

  async drain(): Promise<RuntimeDrainReport> {
    this.order.push("drain");
    return { inFlight: 0, cancelled: 0, unknown: 0 };
  }

  async checkpoint(): Promise<RuntimeCheckpoint> {
    this.order.push("checkpoint");
    return { checkpointId: "checkpoint-1", fencingToken: "fence-1" };
  }

  async switchTraffic(change: RuntimeTrafficSwitch): Promise<void> {
    this.order.push(change.rollback ? "switch-rollback" : "switch-forward");
  }

  async runCanary(): Promise<void> {
    this.order.push("canary");
  }

  async commitCandidate(): Promise<void> {
    this.order.push("commit");
  }

  async resume(): Promise<void> {
    this.order.push("resume");
  }

  async stop(host: RuntimeHostHandle): Promise<void> {
    this.order.push(`stop:${host.instanceId}`);
  }
}

const activeRuntime: RuntimeHostHandle = {
  instanceId: "active-1",
  releaseId: "release-1",
};
const runtimeCandidate: RuntimeReleaseCandidate = {
  releaseId: "release-2",
  directory: "candidate/release-2",
  manifestSha256: "a".repeat(64),
};

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createRendererRelease(
  root: string,
  releaseId: string,
): Promise<{
  readonly source: string;
  readonly manifest: RendererSlotManifest;
}> {
  const source = join(root, `source-${releaseId}`);
  const bytes = Buffer.from(`<html>${releaseId}</html>`, "utf8");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.html"), bytes);
  return {
    source,
    manifest: {
      schemaVersion: RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
      releaseId,
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          sha256: digest(bytes),
          bytes: bytes.length,
        },
      ],
    },
  };
}

class JournalRendererAdapter implements RendererCutoverAdapter {
  readonly order: string[] = [];

  async preflight(target: RendererTarget): Promise<void> {
    this.order.push(`preflight:${target.releaseId}`);
  }

  async captureState(): Promise<unknown> {
    this.order.push("capture");
    return { route: "/tasks", scrollTop: 24 };
  }

  async reload(target: RendererTarget): Promise<void> {
    this.order.push(`reload:${target.releaseId}`);
  }

  async waitUntilReady(target: RendererTarget): Promise<void> {
    this.order.push(`ready:${target.releaseId}`);
  }

  async restoreState(): Promise<void> {
    this.order.push("restore");
  }

  async observe(target: RendererTarget): Promise<void> {
    this.order.push(`observe:${target.releaseId}`);
  }
}

async function rendererFixture(maxRecordsPerCutover = 10_000) {
  const root = await temporaryRoot("scr-journaled-renderer-");
  const slots = new RendererSlotStore({ rootDirectory: join(root, "slots") });
  for (const releaseId of ["renderer-1", "renderer-2"]) {
    const release = await createRendererRelease(root, releaseId);
    await slots.stage(release.manifest, release.source);
  }
  await slots.activate("renderer-1", { expectedGeneration: null });
  const journal = new LayeredCutoverJournal({
    rootDirectory: join(root, "journal"),
    maxRecordsPerCutover,
  });
  return { root, slots, journal };
}

describe("journaled layered cutovers", () => {
  it("persists every Runtime Host transition and a committed terminal record", async () => {
    const root = await temporaryRoot("scr-journaled-runtime-");
    const journal = new LayeredCutoverJournal({
      rootDirectory: join(root, "journal"),
    });
    const adapter = new JournalRuntimeAdapter();
    const receipt = await new RuntimeCutoverCoordinator({
      adapter,
      journal,
    }).cutover({
      cutoverId: "runtime-journal-1",
      active: activeRuntime,
      candidate: runtimeCandidate,
    });

    expect(receipt.outcome).toBe("committed");
    const records = await journal.read("runtime-journal-1");
    expect(records[0]!.record).toMatchObject({
      event: "started",
      kind: "runtime",
      activeReleaseId: "release-1",
      candidateReleaseId: "release-2",
    });
    expect(records.at(-1)!.record).toMatchObject({
      event: "completed",
      outcome: "committed",
      phase: "committed",
    });
    expect(
      records
        .filter((entry) => entry.record.event === "transition")
        .map((entry) => entry.record.phase),
    ).toEqual(receipt.phases.map((phase) => phase.phase));
  });

  it("still stops a candidate when journal capacity fails during cleanup", async () => {
    const root = await temporaryRoot("scr-journaled-runtime-limit-");
    const journal = new LayeredCutoverJournal({
      rootDirectory: join(root, "journal"),
      maxRecordsPerCutover: 2,
    });
    const adapter = new JournalRuntimeAdapter();
    const receipt = await new RuntimeCutoverCoordinator({
      adapter,
      journal,
    }).cutover({
      cutoverId: "runtime-journal-limit",
      active: activeRuntime,
      candidate: runtimeCandidate,
    });

    expect(receipt.outcome).toBe("rolled-back");
    expect(adapter.order).toEqual(["start", "stop:candidate-2"]);
    expect(receipt.cleanupFailures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/journal-transition/u),
        expect.stringMatching(/journal-complete/u),
      ]),
    );
    await expect(journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({
        lastPhase: "start-candidate",
        recoveryAction: "stop-candidate",
      }),
    ]);
  });

  it("persists renderer activation and committed readiness evidence", async () => {
    const { slots, journal } = await rendererFixture();
    const adapter = new JournalRendererAdapter();
    const receipt = await new RendererCutoverCoordinator({
      slots,
      adapter,
      journal,
    }).cutover({
      cutoverId: "renderer-journal-1",
      candidateReleaseId: "renderer-2",
      expectedGeneration: 1,
    });

    expect(receipt.outcome).toBe("committed");
    const records = await journal.read("renderer-journal-1");
    expect(records.at(-1)!.record).toMatchObject({
      event: "completed",
      outcome: "committed",
      details: {
        generation: 2,
        stateBytes: receipt.stateBytes,
      },
    });
    expect(records.map((entry) => entry.record.phase)).toContain(
      "activate-candidate",
    );
    expect(records.map((entry) => entry.record.phase)).toContain(
      "candidate-ready",
    );
  });

  it("rolls the renderer pointer back even when the journal fills after activation", async () => {
    const { slots, journal } = await rendererFixture(5);
    const adapter = new JournalRendererAdapter();
    const receipt = await new RendererCutoverCoordinator({
      slots,
      adapter,
      journal,
    }).cutover({
      cutoverId: "renderer-journal-limit",
      candidateReleaseId: "renderer-2",
      expectedGeneration: 1,
    });

    expect(receipt.outcome).toBe("rolled-back");
    await expect(slots.readPointer()).resolves.toMatchObject({
      activeReleaseId: "renderer-1",
      generation: 3,
    });
    expect(adapter.order).toEqual([
      "preflight:renderer-2",
      "capture",
      "reload:renderer-1",
      "ready:renderer-1",
      "restore",
    ]);
    expect(receipt.cleanupFailures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/journal-transition/u),
        expect.stringMatching(/journal-complete/u),
      ]),
    );
  });
});
