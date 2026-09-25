import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CutoverLedger } from "../src/cutover-ledger.js";
import { CutoverRecoveryInspector } from "../src/cutover-recovery.js";
import {
  CutoverRecoveryExecutor,
  CutoverRecoveryUnsafeError,
  type RendererCutoverRecoveryAdapter,
  type RuntimeCutoverRecoveryAdapter,
} from "../src/cutover-recovery-executor.js";
import type {
  RendererCutoverContext,
  RendererTarget,
} from "../src/renderer-cutover.js";
import {
  RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
  RendererSlotStore,
  type RendererSlotManifest,
} from "../src/renderer-slot.js";
import type {
  RuntimeCutoverContext,
  RuntimeHostHandle,
} from "../src/runtime-cutover.js";
import {
  RuntimeRouteRegistry,
  type RuntimeRouteRevision,
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rendererRelease(
  root: string,
  releaseId: string,
): Promise<{
  readonly source: string;
  readonly manifest: RendererSlotManifest;
}> {
  const source = join(root, releaseId);
  const index = Buffer.from(`<html><body>${releaseId}</body></html>`, "utf8");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.html"), index);
  return {
    source,
    manifest: {
      schemaVersion: RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
      releaseId,
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          bytes: index.length,
          sha256: sha256(index),
        },
      ],
    },
  };
}

function runtimeTarget(releaseId: string, suffix: string): RuntimeRouteTarget {
  return {
    instanceId: `runtime-instance-${suffix}`,
    releaseId,
    routeId: `route:${suffix}`,
    checkpointId: `checkpoint-${suffix}`,
    fencingToken: `fence-${suffix}`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-cutover-recovery-executor-"));
  roots.push(root);
  let clock = 1_000;
  const now = (): number => clock++;
  const ledger = new CutoverLedger({
    rootDirectory: join(root, "ledger"),
    now,
  });
  const routes = new RuntimeRouteRegistry({
    rootDirectory: join(root, "routes"),
    now,
  });
  const rendererSlots = new RendererSlotStore({
    rootDirectory: join(root, "renderer-slots"),
    now,
  });
  await routes.bootstrap(runtimeTarget("runtime-release-1", "one"), {
    cutoverId: "runtime-bootstrap",
    expectedGeneration: null,
  });
  const previousRenderer = await rendererRelease(root, "renderer-release-1");
  const candidateRenderer = await rendererRelease(root, "renderer-release-2");
  await rendererSlots.stage(previousRenderer.manifest, previousRenderer.source);
  await rendererSlots.stage(
    candidateRenderer.manifest,
    candidateRenderer.source,
  );
  await rendererSlots.activate("renderer-release-1", {
    expectedGeneration: null,
  });
  const runtime = new FakeRuntimeRecoveryAdapter();
  const renderer = new FakeRendererRecoveryAdapter();
  const inspector = new CutoverRecoveryInspector({
    ledger,
    routes,
    rendererSlots,
  });
  const executor = new CutoverRecoveryExecutor({
    ledger,
    inspector,
    routes,
    rendererSlots,
    runtime,
    renderer,
    now,
  });
  return {
    root,
    ledger,
    routes,
    rendererSlots,
    runtime,
    renderer,
    inspector,
    executor,
  };
}

class FakeRuntimeRecoveryAdapter implements RuntimeCutoverRecoveryAdapter {
  readonly order: string[] = [];
  readonly appliedRoutes: RuntimeRouteRevision[] = [];

  async applyAuthoritativeRoute(
    revision: RuntimeRouteRevision,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`apply:${revision.active.instanceId}`);
    this.appliedRoutes.push(revision);
  }

  async verifyAuthoritative(
    host: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`verify:${host.instanceId}`);
  }

  async resume(
    active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`resume:${active.instanceId}`);
  }

  async stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`stop:${host.instanceId}:${reason}`);
  }
}

class FakeRendererRecoveryAdapter implements RendererCutoverRecoveryAdapter {
  readonly order: string[] = [];

  async reload(
    target: RendererTarget,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`reload:${target.releaseId}:${target.generation}`);
  }

  async waitUntilReady(
    target: RendererTarget,
    _context: RendererCutoverContext,
  ): Promise<void> {
    this.order.push(`ready:${target.releaseId}:${target.generation}`);
  }
}

async function appendRuntimeInterruption(
  current: Awaited<ReturnType<typeof fixture>>,
  cutoverId: string,
  phase:
    | "candidate-health"
    | "candidate-canary"
    | "commit-candidate"
    | "start-candidate",
  candidateInstanceId: string | null = "runtime-instance-two",
): Promise<void> {
  await current.ledger.appendRuntimeTransition(
    {
      cutoverId,
      phase,
      at: 100,
      activeInstanceId: "runtime-instance-one",
      candidateInstanceId,
    },
    {
      activeReleaseId: "runtime-release-1",
      candidateReleaseId: "runtime-release-2",
    },
  );
}

async function appendRendererInterruption(
  current: Awaited<ReturnType<typeof fixture>>,
  cutoverId: string,
  phase: "preflight-candidate" | "candidate-ready" | "committed",
  generation: number,
): Promise<void> {
  await current.ledger.appendRendererTransition({
    cutoverId,
    phase,
    at: 100,
    previousReleaseId: "renderer-release-1",
    candidateReleaseId: "renderer-release-2",
    generation,
  });
}

describe("CutoverRecoveryExecutor", () => {
  it("rolls Runtime traffic back, resumes the previous host, stops the candidate, and closes the ledger", async () => {
    const current = await fixture();
    await appendRuntimeInterruption(
      current,
      "runtime-canary-interrupted",
      "candidate-canary",
    );
    await current.routes.switchTo(runtimeTarget("runtime-release-2", "two"), {
      cutoverId: "runtime-canary-interrupted",
      expectedGeneration: 1,
    });

    const receipt = await current.executor.recover(
      "runtime-canary-interrupted",
    );

    expect(receipt).toMatchObject({
      kind: "runtime",
      action: "rollback-traffic-resume-active-stop-candidate",
      outcome: "rolled-back",
      authorityGeneration: 3,
      authoritativeReleaseId: "runtime-release-1",
    });
    expect(current.runtime.order).toEqual([
      "apply:runtime-instance-one",
      "verify:runtime-instance-one",
      "resume:runtime-instance-one",
      "stop:runtime-instance-two:cutover-rolled-back",
    ]);
    await expect(current.routes.readCurrent()).resolves.toMatchObject({
      generation: 3,
      operation: "rollback",
      active: { instanceId: "runtime-instance-one" },
      previous: { instanceId: "runtime-instance-two" },
    });
    await expect(current.inspector.inspect()).resolves.toEqual([]);
    expect((await current.ledger.readAll()).at(-1)?.payload).toMatchObject({
      recordType: "receipt",
      outcome: "rolled-back",
    });
  });

  it("stops an unhealthy pre-switch candidate without changing Runtime authority", async () => {
    const current = await fixture();
    await appendRuntimeInterruption(
      current,
      "runtime-health-interrupted",
      "candidate-health",
    );

    const receipt = await current.executor.recover(
      "runtime-health-interrupted",
    );

    expect(receipt).toMatchObject({
      action: "stop-candidate",
      outcome: "rolled-back",
      authorityGeneration: 1,
    });
    expect(current.runtime.order).toEqual([
      "stop:runtime-instance-two:candidate-rejected",
    ]);
    await expect(current.routes.readCurrent()).resolves.toMatchObject({
      generation: 1,
      active: { instanceId: "runtime-instance-one" },
    });
  });

  it("finishes committed Runtime route cleanup without rolling traffic backward", async () => {
    const current = await fixture();
    await appendRuntimeInterruption(
      current,
      "runtime-commit-interrupted",
      "commit-candidate",
    );
    await current.routes.switchTo(runtimeTarget("runtime-release-2", "two"), {
      cutoverId: "runtime-commit-interrupted",
      expectedGeneration: 1,
    });
    await current.routes.commit({
      cutoverId: "runtime-commit-route",
      expectedGeneration: 2,
    });

    const receipt = await current.executor.recover(
      "runtime-commit-interrupted",
    );

    expect(receipt).toMatchObject({
      action: "finish-commit-cleanup",
      outcome: "committed",
      authoritativeReleaseId: "runtime-release-2",
    });
    expect(current.runtime.order).toEqual([
      "verify:runtime-instance-two",
      "stop:runtime-instance-one:cutover-committed",
    ]);
    await expect(current.routes.readCurrent()).resolves.toMatchObject({
      generation: 3,
      operation: "commit",
      active: { instanceId: "runtime-instance-two" },
      previous: null,
    });
  });

  it("refuses automatic Runtime recovery when the interrupted candidate instance is unknown", async () => {
    const current = await fixture();
    await appendRuntimeInterruption(
      current,
      "runtime-start-interrupted",
      "start-candidate",
      null,
    );

    await expect(
      current.executor.recover("runtime-start-interrupted"),
    ).rejects.toThrow(/does not identify a candidate host/u);
    expect(current.runtime.order).toEqual([]);
    expect((await current.ledger.readAll()).at(-1)?.payload.recordType).toBe(
      "transition",
    );
  });

  it("rolls the renderer pointer back, reloads the previous slot, and closes the ledger", async () => {
    const current = await fixture();
    await appendRendererInterruption(
      current,
      "renderer-ready-interrupted",
      "candidate-ready",
      2,
    );
    await current.rendererSlots.activate("renderer-release-2", {
      expectedGeneration: 1,
    });

    const receipt = await current.executor.recover(
      "renderer-ready-interrupted",
    );

    expect(receipt).toMatchObject({
      kind: "renderer",
      action: "rollback-renderer",
      outcome: "rolled-back",
      authorityGeneration: 3,
      authoritativeReleaseId: "renderer-release-1",
    });
    expect(current.renderer.order).toEqual([
      "reload:renderer-release-1:3",
      "ready:renderer-release-1:3",
    ]);
    await expect(current.rendererSlots.readPointer()).resolves.toMatchObject({
      generation: 3,
      activeReleaseId: "renderer-release-1",
      previousReleaseId: "renderer-release-2",
    });
    await expect(current.inspector.inspect()).resolves.toEqual([]);
  });

  it("closes a pre-activation renderer interruption without changing or reloading the pointer", async () => {
    const current = await fixture();
    await appendRendererInterruption(
      current,
      "renderer-preflight-interrupted",
      "preflight-candidate",
      1,
    );

    const receipt = await current.executor.recover(
      "renderer-preflight-interrupted",
    );

    expect(receipt).toMatchObject({
      action: "none",
      outcome: "rolled-back",
      authorityGeneration: 1,
    });
    expect(current.renderer.order).toEqual([]);
    await expect(current.rendererSlots.readPointer()).resolves.toMatchObject({
      generation: 1,
      activeReleaseId: "renderer-release-1",
    });
  });

  it("does not auto-accept a terminal renderer transition missing its receipt", async () => {
    const current = await fixture();
    await appendRendererInterruption(
      current,
      "renderer-terminal-interrupted",
      "committed",
      2,
    );
    await current.rendererSlots.activate("renderer-release-2", {
      expectedGeneration: 1,
    });

    await expect(
      current.executor.recover("renderer-terminal-interrupted"),
    ).rejects.toBeInstanceOf(CutoverRecoveryUnsafeError);
    expect(current.renderer.order).toEqual([]);
  });
});
