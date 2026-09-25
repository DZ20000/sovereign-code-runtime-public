import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CutoverLedger } from "../src/cutover-ledger.js";
import { LayeredUpdateStatusService } from "../src/layered-update-status.js";
import type { RendererCutoverReceipt } from "../src/renderer-cutover.js";
import {
  RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
  RendererSlotStore,
  type RendererSlotManifest,
} from "../src/renderer-slot.js";
import type { RuntimeCutoverReceipt } from "../src/runtime-cutover.js";
import {
  RuntimeRouteRegistry,
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

async function fixture(options: { readonly initialized?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scr-layered-update-status-"));
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
  if (options.initialized === true) {
    await routes.bootstrap(runtimeTarget("runtime-release-1", "one"), {
      cutoverId: "runtime-bootstrap",
      expectedGeneration: null,
    });
    const renderer = await rendererRelease(root, "renderer-release-1");
    await rendererSlots.stage(renderer.manifest, renderer.source);
    await rendererSlots.activate(renderer.manifest.releaseId, {
      expectedGeneration: null,
    });
  }
  return {
    root,
    ledger,
    routes,
    rendererSlots,
    service: new LayeredUpdateStatusService({
      ledger,
      routes,
      rendererSlots,
      now,
    }),
  };
}

function runtimeReceipt(
  cutoverId: string,
  outcome: RuntimeCutoverReceipt["outcome"] = "committed",
): RuntimeCutoverReceipt {
  return {
    cutoverId,
    outcome,
    activeReleaseId: "runtime-release-1",
    candidateReleaseId: "runtime-release-2",
    previousInstanceId: "runtime-instance-one",
    candidateInstanceId: "runtime-instance-two",
    checkpointId: "checkpoint-two",
    startedAt: 100,
    completedAt: 200,
    failureReason: outcome === "committed" ? null : "candidate rejected",
    cleanupFailures: [],
    phases: [],
  };
}

function rendererReceipt(
  cutoverId: string,
  outcome: RendererCutoverReceipt["outcome"] = "committed",
): RendererCutoverReceipt {
  return {
    cutoverId,
    outcome,
    previousReleaseId: "renderer-release-1",
    candidateReleaseId: "renderer-release-2",
    previousGeneration: 1,
    finalGeneration: outcome === "committed" ? 2 : 3,
    stateBytes: 128,
    startedAt: 100,
    completedAt: 200,
    failureReason: outcome === "committed" ? null : "renderer rejected",
    cleanupFailures: [],
    phases: [],
  };
}

describe("LayeredUpdateStatusService", () => {
  it("reports uninitialized authority without manufacturing a healthy state", async () => {
    const current = await fixture();

    await expect(current.service.snapshot()).resolves.toMatchObject({
      schemaVersion: "scr.layered-update-status/v1",
      health: "uninitialized",
      ledgerHeadSequence: 0,
      ledgerHeadSha256: null,
      runtimeRoute: null,
      renderer: null,
      recoveries: [],
      recentCutovers: [],
    });
  });

  it("projects verified Runtime and renderer authority into a ready status", async () => {
    const current = await fixture({ initialized: true });

    const status = await current.service.snapshot();
    expect(status).toMatchObject({
      health: "ready",
      runtimeRoute: {
        generation: 1,
        operation: "bootstrap",
        active: {
          instanceId: "runtime-instance-one",
          releaseId: "runtime-release-1",
          fencingToken: "fence-one",
        },
        previous: null,
      },
      renderer: {
        generation: 1,
        activeReleaseId: "renderer-release-1",
        previousReleaseId: null,
      },
      recoveries: [],
    });
    expect(status.renderer?.activeEntrypoint).toMatch(/index\.html$/u);
    expect(status.renderer?.activeManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("returns bounded recent receipts newest-first", async () => {
    const current = await fixture({ initialized: true });
    await current.ledger.appendRuntimeReceipt(
      runtimeReceipt("runtime-cutover-1"),
    );
    await current.ledger.appendRendererReceipt(
      rendererReceipt("renderer-cutover-2", "rolled-back"),
    );
    const service = new LayeredUpdateStatusService({
      ledger: current.ledger,
      routes: current.routes,
      rendererSlots: current.rendererSlots,
      recentCutoverLimit: 1,
      now: () => 9_999,
    });

    await expect(service.snapshot()).resolves.toMatchObject({
      generatedAt: 9_999,
      ledgerHeadSequence: 2,
      recentCutovers: [
        {
          cutoverId: "renderer-cutover-2",
          kind: "renderer",
          outcome: "rolled-back",
          activeReleaseId: "renderer-release-1",
          candidateReleaseId: "renderer-release-2",
          failureReason: "renderer rejected",
          completedSequence: 2,
        },
      ],
    });
  });

  it("reports safe interrupted cutovers as recovery-required", async () => {
    const current = await fixture({ initialized: true });
    const candidate = await rendererRelease(current.root, "renderer-release-2");
    await current.rendererSlots.stage(candidate.manifest, candidate.source);
    await current.ledger.appendRendererTransition({
      cutoverId: "renderer-interrupted",
      phase: "candidate-ready",
      at: 100,
      previousReleaseId: "renderer-release-1",
      candidateReleaseId: "renderer-release-2",
      generation: 2,
    });
    await current.rendererSlots.activate("renderer-release-2", {
      expectedGeneration: 1,
    });

    await expect(current.service.snapshot()).resolves.toMatchObject({
      health: "recovery-required",
      renderer: {
        activeReleaseId: "renderer-release-2",
        previousReleaseId: "renderer-release-1",
        generation: 2,
      },
      recoveries: [
        {
          cutoverId: "renderer-interrupted",
          kind: "renderer",
          action: "rollback-renderer",
          safeToAutomate: true,
          authoritativeReleaseId: "renderer-release-2",
          rollbackReleaseId: "renderer-release-1",
          authorityGeneration: 2,
        },
      ],
    });
  });

  it("requires manual intervention for terminal transitions missing a receipt", async () => {
    const current = await fixture({ initialized: true });
    const candidate = await rendererRelease(current.root, "renderer-release-2");
    await current.rendererSlots.stage(candidate.manifest, candidate.source);
    await current.ledger.appendRendererTransition({
      cutoverId: "renderer-terminal-without-receipt",
      phase: "committed",
      at: 100,
      previousReleaseId: "renderer-release-1",
      candidateReleaseId: "renderer-release-2",
      generation: 2,
    });
    await current.rendererSlots.activate("renderer-release-2", {
      expectedGeneration: 1,
    });

    await expect(current.service.snapshot()).resolves.toMatchObject({
      health: "manual-intervention",
      recoveries: [
        {
          action: "verify-terminal-state",
          safeToAutomate: false,
        },
      ],
    });
  });

  it("fails the status snapshot when the active renderer slot was tampered", async () => {
    const current = await fixture({ initialized: true });
    const renderer =
      await current.rendererSlots.verifySlot("renderer-release-1");
    await writeFile(renderer.entrypoint, "tampered", "utf8");

    await expect(current.service.snapshot()).rejects.toThrow(/Renderer/u);
  });

  it("rejects invalid recent-cutover limits", async () => {
    const current = await fixture();
    expect(
      () =>
        new LayeredUpdateStatusService({
          ledger: current.ledger,
          routes: current.routes,
          rendererSlots: current.rendererSlots,
          recentCutoverLimit: 0,
        }),
    ).toThrow(/recent-cutover limit/u);
    expect(
      () =>
        new LayeredUpdateStatusService({
          ledger: current.ledger,
          routes: current.routes,
          rendererSlots: current.rendererSlots,
          recentCutoverLimit: 201,
        }),
    ).toThrow(/recent-cutover limit/u);
  });
});
