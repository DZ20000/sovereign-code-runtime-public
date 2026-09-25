import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CutoverLedger } from "../src/cutover-ledger.js";
import { CutoverRecoveryInspector } from "../src/cutover-recovery.js";
import {
  RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
  RendererSlotStore,
  type RendererSlotManifest,
} from "../src/renderer-slot.js";
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
        { path: "index.html", bytes: bytes.length, sha256: sha256(bytes) },
      ],
    },
  };
}

function runtimeTarget(releaseId: string, suffix: string): RuntimeRouteTarget {
  return {
    instanceId: `runtime-${suffix}`,
    releaseId,
    routeId: `route:${suffix}`,
    checkpointId: `checkpoint-${suffix}`,
    fencingToken: `fence-${suffix}`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-cutover-recovery-"));
  roots.push(root);
  const ledger = new CutoverLedger({ rootDirectory: join(root, "ledger") });
  const routes = new RuntimeRouteRegistry({
    rootDirectory: join(root, "routes"),
  });
  const rendererSlots = new RendererSlotStore({
    rootDirectory: join(root, "renderer-slots"),
  });
  await routes.bootstrap(runtimeTarget("runtime-release-1", "one"), {
    cutoverId: "runtime-bootstrap",
    expectedGeneration: null,
  });
  const rendererOne = await rendererRelease(root, "renderer-release-1");
  const rendererTwo = await rendererRelease(root, "renderer-release-2");
  await rendererSlots.stage(rendererOne.manifest, rendererOne.source);
  await rendererSlots.stage(rendererTwo.manifest, rendererTwo.source);
  await rendererSlots.activate("renderer-release-1", {
    expectedGeneration: null,
  });
  return { root, ledger, routes, rendererSlots };
}

function inspector(
  input: Awaited<ReturnType<typeof fixture>>,
): CutoverRecoveryInspector {
  return new CutoverRecoveryInspector({
    ledger: input.ledger,
    routes: input.routes,
    rendererSlots: input.rendererSlots,
  });
}

describe("CutoverRecoveryInspector", () => {
  it("uses the authoritative route to distinguish forward traffic from an already-restored Runtime Host", async () => {
    const current = await fixture();
    await current.ledger.appendRuntimeTransition(
      {
        cutoverId: "runtime-interrupted",
        phase: "candidate-canary",
        at: 100,
        activeInstanceId: "runtime-one",
        candidateInstanceId: "runtime-two",
      },
      {
        activeReleaseId: "runtime-release-1",
        candidateReleaseId: "runtime-release-2",
      },
    );
    await current.routes.switchTo(runtimeTarget("runtime-release-2", "two"), {
      cutoverId: "runtime-interrupted",
      expectedGeneration: 1,
    });

    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        cutoverId: "runtime-interrupted",
        resolvedAction: "rollback-traffic-resume-active-stop-candidate",
        safeToAutomate: true,
        authoritativeReleaseId: "runtime-release-2",
        rollbackReleaseId: "runtime-release-1",
        authorityGeneration: 2,
      }),
    ]);

    await current.routes.rollback({
      cutoverId: "runtime-interrupted-route-rollback",
      expectedGeneration: 2,
    });
    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "resume-active-and-stop-candidate",
        safeToAutomate: true,
        authoritativeReleaseId: "runtime-release-1",
      }),
    ]);
  });

  it("recognizes a committed candidate route that only needs old-host cleanup", async () => {
    const current = await fixture();
    await current.ledger.appendRuntimeTransition(
      {
        cutoverId: "runtime-commit-interrupted",
        phase: "commit-candidate",
        at: 100,
        activeInstanceId: "runtime-one",
        candidateInstanceId: "runtime-two",
      },
      {
        activeReleaseId: "runtime-release-1",
        candidateReleaseId: "runtime-release-2",
      },
    );
    await current.routes.switchTo(runtimeTarget("runtime-release-2", "two"), {
      cutoverId: "runtime-commit-interrupted",
      expectedGeneration: 1,
    });
    await current.routes.commit({
      cutoverId: "runtime-commit-interrupted-route-commit",
      expectedGeneration: 2,
    });

    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "finish-commit-cleanup",
        safeToAutomate: true,
        authoritativeReleaseId: "runtime-release-2",
        rollbackReleaseId: null,
      }),
    ]);
  });

  it("fails a Runtime recovery closed when the authoritative route is unrelated", async () => {
    const current = await fixture();
    await current.ledger.appendRuntimeTransition(
      {
        cutoverId: "runtime-mismatch",
        phase: "candidate-canary",
        at: 100,
        activeInstanceId: "runtime-one",
        candidateInstanceId: "runtime-two",
      },
      {
        activeReleaseId: "runtime-release-1",
        candidateReleaseId: "runtime-release-2",
      },
    );
    await current.routes.switchTo(runtimeTarget("runtime-release-3", "three"), {
      cutoverId: "unrelated-cutover",
      expectedGeneration: 1,
    });

    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "manual-intervention",
        safeToAutomate: false,
        authoritativeReleaseId: "runtime-release-3",
      }),
    ]);
  });

  it("uses the renderer pointer to decide whether rollback is still required", async () => {
    const current = await fixture();
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

    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "rollback-renderer",
        safeToAutomate: true,
        authoritativeReleaseId: "renderer-release-2",
        rollbackReleaseId: "renderer-release-1",
        authorityGeneration: 2,
      }),
    ]);

    await current.rendererSlots.rollback({ expectedGeneration: 2 });
    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "finish-renderer-rollback",
        safeToAutomate: true,
        authoritativeReleaseId: "renderer-release-1",
      }),
    ]);
  });

  it("requires no renderer pointer change when interruption happened before activation", async () => {
    const current = await fixture();
    await current.ledger.appendRendererTransition({
      cutoverId: "renderer-preflight-interrupted",
      phase: "preflight-candidate",
      at: 100,
      previousReleaseId: "renderer-release-1",
      candidateReleaseId: "renderer-release-2",
      generation: 1,
    });

    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "none",
        safeToAutomate: true,
        authoritativeReleaseId: "renderer-release-1",
      }),
    ]);
  });

  it("does not auto-accept a terminal transition whose receipt is missing", async () => {
    const current = await fixture();
    await current.ledger.appendRendererTransition({
      cutoverId: "renderer-terminal-no-receipt",
      phase: "committed",
      at: 100,
      previousReleaseId: "renderer-release-1",
      candidateReleaseId: "renderer-release-2",
      generation: 2,
    });
    await current.rendererSlots.activate("renderer-release-2", {
      expectedGeneration: 1,
    });

    await expect(inspector(current).inspect()).resolves.toEqual([
      expect.objectContaining({
        resolvedAction: "verify-terminal-state",
        safeToAutomate: false,
      }),
    ]);
  });
});
