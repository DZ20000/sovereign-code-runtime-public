import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RendererCutoverBusyError,
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

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function release(
  root: string,
  releaseId: string,
): Promise<{ readonly source: string; readonly manifest: RendererSlotManifest }> {
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
      files: [{ path: "index.html", bytes: bytes.length, sha256: digest(bytes) }],
    },
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "scr-renderer-cutover-"));
  roots.push(root);
  const slots = new RendererSlotStore({ rootDirectory: join(root, "slots") });
  const previous = await release(root, "renderer-1");
  const candidate = await release(root, "renderer-2");
  await slots.stage(previous.manifest, previous.source);
  await slots.stage(candidate.manifest, candidate.source);
  await slots.activate(previous.manifest.releaseId, { expectedGeneration: null });
  return { root, slots };
}

class FakeRendererAdapter implements RendererCutoverAdapter {
  readonly order: string[] = [];
  failAt: string | null = null;
  state: unknown = {
    route: "/tasks/task-1",
    draft: "unsent text",
    scrollTop: 120,
  };
  preflightGate: Promise<void> | null = null;

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async preflight(
    target: RendererTarget,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`preflight:${target.releaseId}`);
    this.#fail("preflight");
    if (this.preflightGate !== null) await this.preflightGate;
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

  async restoreState(_state: unknown, _context: RendererCutoverContext): Promise<void> {
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

describe("RendererCutoverCoordinator", () => {
  it("preflights, captures, activates, reloads, restores, and observes without restarting Runtime Host", async () => {
    const { slots } = await setup();
    const adapter = new FakeRendererAdapter();
    const coordinator = new RendererCutoverCoordinator({ slots, adapter });

    const receipt = await coordinator.cutover({
      cutoverId: "renderer-cutover-1",
      candidateReleaseId: "renderer-2",
      expectedGeneration: 1,
    });

    expect(receipt).toMatchObject({
      outcome: "committed",
      previousReleaseId: "renderer-1",
      candidateReleaseId: "renderer-2",
      previousGeneration: 1,
      finalGeneration: 2,
      failureReason: null,
    });
    expect(receipt.stateBytes).toBeGreaterThan(0);
    expect(adapter.order).toEqual([
      "preflight:renderer-2",
      "capture",
      "reload:renderer-2",
      "ready:renderer-2",
      "restore",
      "observe:renderer-2",
    ]);
    await expect(slots.readPointer()).resolves.toMatchObject({
      generation: 2,
      activeReleaseId: "renderer-2",
      previousReleaseId: "renderer-1",
    });
  });

  it("rolls the pointer and UI back when candidate observation fails", async () => {
    const { slots } = await setup();
    const adapter = new FakeRendererAdapter();
    adapter.failAt = "observe";
    const coordinator = new RendererCutoverCoordinator({ slots, adapter });

    const receipt = await coordinator.cutover({
      cutoverId: "renderer-cutover-rollback",
      candidateReleaseId: "renderer-2",
    });

    expect(receipt).toMatchObject({
      outcome: "rolled-back",
      finalGeneration: 3,
    });
    expect(receipt.failureReason).toMatch(/observe failed/u);
    expect(adapter.order.slice(-3)).toEqual([
      "reload:renderer-1",
      "ready:renderer-1",
      "restore",
    ]);
    await expect(slots.readPointer()).resolves.toMatchObject({
      generation: 3,
      activeReleaseId: "renderer-1",
      previousReleaseId: "renderer-2",
    });
  });

  it("leaves the pointer untouched when preflight or state validation fails", async () => {
    const first = await setup();
    const preflight = new FakeRendererAdapter();
    preflight.failAt = "preflight";
    const preflightReceipt = await new RendererCutoverCoordinator({
      slots: first.slots,
      adapter: preflight,
    }).cutover({
      cutoverId: "renderer-cutover-preflight",
      candidateReleaseId: "renderer-2",
    });
    expect(preflightReceipt.outcome).toBe("rolled-back");
    await expect(first.slots.readPointer()).resolves.toMatchObject({
      generation: 1,
      activeReleaseId: "renderer-1",
    });

    const second = await setup();
    const oversized = new FakeRendererAdapter();
    oversized.state = { draft: "x".repeat(2_000) };
    const oversizedReceipt = await new RendererCutoverCoordinator({
      slots: second.slots,
      adapter: oversized,
      policy: { maxStateBytes: 128 },
    }).cutover({
      cutoverId: "renderer-cutover-state",
      candidateReleaseId: "renderer-2",
    });
    expect(oversizedReceipt.outcome).toBe("rolled-back");
    expect(oversizedReceipt.failureReason).toMatch(/handoff limit/u);
    await expect(second.slots.readPointer()).resolves.toMatchObject({ generation: 1 });
  });

  it("fails closed when the previous renderer cannot be restored", async () => {
    const { slots } = await setup();
    const adapter = new FakeRendererAdapter();
    adapter.failAt = "observe";
    const originalReload = adapter.reload.bind(adapter);
    adapter.reload = async (target, state, context) => {
      if (target.releaseId === "renderer-1") {
        adapter.order.push("reload:renderer-1");
        throw new Error("previous renderer reload failed");
      }
      await originalReload(target, state, context);
    };

    const receipt = await new RendererCutoverCoordinator({ slots, adapter }).cutover({
      cutoverId: "renderer-cutover-failed-rollback",
      candidateReleaseId: "renderer-2",
    });

    expect(receipt.outcome).toBe("failed");
    expect(receipt.cleanupFailures).toEqual([
      expect.stringMatching(/reload-previous: previous renderer reload failed/u),
    ]);
    await expect(slots.readPointer()).resolves.toMatchObject({
      activeReleaseId: "renderer-1",
      generation: 3,
    });
  });

  it("rejects concurrent renderer cutovers so generation assumptions cannot go stale", async () => {
    const { slots } = await setup();
    const adapter = new FakeRendererAdapter();
    let releasePreflight!: () => void;
    adapter.preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const coordinator = new RendererCutoverCoordinator({ slots, adapter });
    const first = coordinator.cutover({
      cutoverId: "renderer-cutover-first",
      candidateReleaseId: "renderer-2",
    });
    await Promise.resolve();

    await expect(
      coordinator.cutover({
        cutoverId: "renderer-cutover-second",
        candidateReleaseId: "renderer-2",
      }),
    ).rejects.toBeInstanceOf(RendererCutoverBusyError);

    releasePreflight();
    await expect(first).resolves.toMatchObject({ outcome: "committed" });
  });

  it("ignores transition-listener failures", async () => {
    const { slots } = await setup();
    const adapter = new FakeRendererAdapter();
    const receipt = await new RendererCutoverCoordinator({
      slots,
      adapter,
      onTransition: () => {
        throw new Error("telemetry unavailable");
      },
    }).cutover({
      cutoverId: "renderer-cutover-telemetry",
      candidateReleaseId: "renderer-2",
    });
    expect(receipt.outcome).toBe("committed");
  });
});
