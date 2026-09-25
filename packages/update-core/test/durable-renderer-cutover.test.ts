import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CutoverLedger } from "../src/cutover-ledger.js";
import { DurableRendererCutoverCoordinator } from "../src/durable-renderer-cutover.js";
import type {
  RendererCutoverAdapter,
  RendererCutoverContext,
  RendererTarget,
} from "../src/renderer-cutover.js";
import {
  RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
  RendererSlotStore,
  type RendererSlotManifest,
} from "../src/renderer-slot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function release(
  root: string,
  releaseId: string,
): Promise<{
  readonly source: string;
  readonly manifest: RendererSlotManifest;
}> {
  const source = join(root, releaseId);
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
        { path: "index.html", bytes: bytes.length, sha256: digest(bytes) },
      ],
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-durable-renderer-cutover-"));
  roots.push(root);
  const slots = new RendererSlotStore({ rootDirectory: join(root, "slots") });
  const ledger = new CutoverLedger({ rootDirectory: join(root, "ledger") });
  const previous = await release(root, "renderer-release-1");
  const candidate = await release(root, "renderer-release-2");
  await slots.stage(previous.manifest, previous.source);
  await slots.stage(candidate.manifest, candidate.source);
  await slots.activate(previous.manifest.releaseId, {
    expectedGeneration: null,
  });
  return { root, slots, ledger };
}

class FakeAdapter implements RendererCutoverAdapter {
  readonly order: string[] = [];
  failAt: string | null = null;
  state: unknown = { view: "tasks", draft: "unsent", scrollTop: 42 };

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async preflight(
    target: RendererTarget,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`preflight:${target.releaseId}`);
    this.#fail("preflight");
  }

  async captureState(_context: RendererCutoverContext): Promise<unknown> {
    this.order.push("capture");
    this.#fail("capture");
    return this.state;
  }

  async reload(
    target: RendererTarget,
    _state: unknown,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`reload:${target.releaseId}`);
    this.#fail(`reload:${target.releaseId}`);
  }

  async waitUntilReady(
    target: RendererTarget,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`ready:${target.releaseId}`);
    this.#fail(`ready:${target.releaseId}`);
  }

  async restoreState(
    _state: unknown,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push("restore");
    this.#fail("restore");
  }

  async observe(
    target: RendererTarget,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`observe:${target.releaseId}`);
    this.#fail("observe");
  }
}

describe("DurableRendererCutoverCoordinator", () => {
  it("records each phase before activation and closes the committed cutover", async () => {
    const { slots, ledger } = await fixture();
    const adapter = new FakeAdapter();
    const receipt = await new DurableRendererCutoverCoordinator({
      adapter,
      slots,
      ledger,
    }).cutover({
      cutoverId: "durable-renderer-1",
      candidateReleaseId: "renderer-release-2",
      expectedGeneration: 1,
    });

    expect(receipt).toMatchObject({
      outcome: "committed",
      previousGeneration: 1,
      finalGeneration: 2,
    });
    await expect(slots.readPointer()).resolves.toMatchObject({
      generation: 2,
      activeReleaseId: "renderer-release-2",
    });
    const entries = await ledger.readAll();
    expect(entries.at(-1)?.payload).toMatchObject({
      recordType: "receipt",
      outcome: "committed",
      generation: 2,
    });
    expect(entries.map((entry) => entry.payload.phase).filter(Boolean)).toEqual(
      [
        "verify-candidate",
        "preflight-candidate",
        "capture-view-state",
        "activate-candidate",
        "reload-candidate",
        "candidate-ready",
        "restore-view-state",
        "observe-candidate",
        "committed",
      ],
    );
    await expect(ledger.recoveryPlans()).resolves.toEqual([]);
  });

  it("records and completes a durable rollback after candidate observation fails", async () => {
    const { slots, ledger } = await fixture();
    const adapter = new FakeAdapter();
    adapter.failAt = "observe";
    const receipt = await new DurableRendererCutoverCoordinator({
      adapter,
      slots,
      ledger,
    }).cutover({
      cutoverId: "durable-renderer-rollback",
      candidateReleaseId: "renderer-release-2",
    });

    expect(receipt).toMatchObject({
      outcome: "rolled-back",
      finalGeneration: 3,
    });
    await expect(slots.readPointer()).resolves.toMatchObject({
      generation: 3,
      activeReleaseId: "renderer-release-1",
    });
    const phases = (await ledger.readAll())
      .map((entry) => entry.payload.phase)
      .filter(Boolean);
    expect(phases.slice(-5)).toEqual([
      "rollback-pointer",
      "reload-previous",
      "previous-ready",
      "restore-previous-state",
      "rolled-back",
    ]);
    await expect(ledger.recoveryPlans()).resolves.toEqual([]);
  });

  it("does not activate a candidate when preflight or bounded state capture fails", async () => {
    const first = await fixture();
    const preflight = new FakeAdapter();
    preflight.failAt = "preflight";
    const preflightReceipt = await new DurableRendererCutoverCoordinator({
      adapter: preflight,
      slots: first.slots,
      ledger: first.ledger,
    }).cutover({
      cutoverId: "durable-renderer-preflight",
      candidateReleaseId: "renderer-release-2",
    });
    expect(preflightReceipt.outcome).toBe("rolled-back");
    await expect(first.slots.readPointer()).resolves.toMatchObject({
      generation: 1,
    });

    const second = await fixture();
    const oversized = new FakeAdapter();
    oversized.state = { draft: "x".repeat(4_096) };
    const stateReceipt = await new DurableRendererCutoverCoordinator({
      adapter: oversized,
      slots: second.slots,
      ledger: second.ledger,
      policy: { maxStateBytes: 128 },
    }).cutover({
      cutoverId: "durable-renderer-state",
      candidateReleaseId: "renderer-release-2",
    });
    expect(stateReceipt.outcome).toBe("rolled-back");
    expect(stateReceipt.failureReason).toMatch(/handoff limit/u);
    await expect(second.slots.readPointer()).resolves.toMatchObject({
      generation: 1,
    });
  });

  it("marks the outcome failed if the previous renderer cannot be reloaded", async () => {
    const { slots, ledger } = await fixture();
    const adapter = new FakeAdapter();
    adapter.failAt = "observe";
    const originalReload = adapter.reload.bind(adapter);
    adapter.reload = async (target, state, context) => {
      if (target.releaseId === "renderer-release-1") {
        adapter.order.push("reload:renderer-release-1");
        throw new Error("previous renderer reload failed");
      }
      await originalReload(target, state, context);
    };
    const receipt = await new DurableRendererCutoverCoordinator({
      adapter,
      slots,
      ledger,
    }).cutover({
      cutoverId: "durable-renderer-failed-rollback",
      candidateReleaseId: "renderer-release-2",
    });

    expect(receipt.outcome).toBe("failed");
    expect(receipt.cleanupFailures).toEqual([
      expect.stringMatching(
        /reload-previous: previous renderer reload failed/u,
      ),
    ]);
    expect((await ledger.readAll()).at(-1)?.payload.outcome).toBe("failed");
  });

  it("rejects a stale generation before writing any cutover records", async () => {
    const { slots, ledger } = await fixture();
    const adapter = new FakeAdapter();
    const coordinator = new DurableRendererCutoverCoordinator({
      adapter,
      slots,
      ledger,
    });
    await expect(
      coordinator.cutover({
        cutoverId: "durable-renderer-stale",
        candidateReleaseId: "renderer-release-2",
        expectedGeneration: 99,
      }),
    ).rejects.toThrow(/generation changed/u);
    expect(adapter.order).toEqual([]);
    await expect(ledger.readAll()).resolves.toEqual([]);
  });
});
