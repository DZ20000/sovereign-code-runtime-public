import { describe, expect, it } from "vitest";

import {
  LayeredUpdateBusyError,
  LayeredUpdateOrchestrator,
  type LayeredUpdateContext,
  type LayeredUpdateHandlers,
  type RestartUpdateReceipt,
} from "../src/layered-orchestrator.js";
import type { ReleaseManifest } from "../src/manifest.js";
import type { RendererCutoverReceipt } from "../src/renderer-cutover.js";
import type { RuntimeCutoverReceipt } from "../src/runtime-cutover.js";

interface ComponentFixture {
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
}

function manifest(
  releaseId: string,
  components: readonly ComponentFixture[],
): ReleaseManifest {
  return {
    releaseId,
    components: components.map((component, index) => ({
      ...component,
      bytes: index + 1,
    })),
  } as unknown as ReleaseManifest;
}

function rendererReceipt(
  context: LayeredUpdateContext,
): RendererCutoverReceipt {
  return {
    cutoverId: context.updateId,
    outcome: "committed",
    previousReleaseId: context.plan.currentReleaseId,
    candidateReleaseId: context.plan.candidateReleaseId,
    previousGeneration: 1,
    finalGeneration: 2,
    stateBytes: 128,
    startedAt: context.startedAt,
    completedAt: context.startedAt + 1,
    failureReason: null,
    cleanupFailures: [],
    phases: [],
  };
}

function runtimeReceipt(context: LayeredUpdateContext): RuntimeCutoverReceipt {
  return {
    cutoverId: context.updateId,
    outcome: "committed",
    activeReleaseId: context.plan.currentReleaseId,
    candidateReleaseId: context.plan.candidateReleaseId,
    previousInstanceId: "runtime-active",
    candidateInstanceId: "runtime-candidate",
    checkpointId: "checkpoint-1",
    startedAt: context.startedAt,
    completedAt: context.startedAt + 1,
    failureReason: null,
    cleanupFailures: [],
    phases: [],
  };
}

function restartReceipt(context: LayeredUpdateContext): RestartUpdateReceipt {
  return {
    updateId: context.updateId,
    outcome: "committed",
    currentReleaseId: context.plan.currentReleaseId,
    candidateReleaseId: context.plan.candidateReleaseId,
    failureReason: null,
    cleanupFailures: [],
  };
}

function handlers(order: string[]): LayeredUpdateHandlers {
  return {
    rendererReload: async (context) => {
      order.push("renderer");
      return rendererReceipt(context);
    },
    runtimeRolling: async (context) => {
      order.push("runtime");
      return runtimeReceipt(context);
    },
    applicationRestart: async (context) => {
      order.push("restart");
      return restartReceipt(context);
    },
    maintenance: async (context) => {
      order.push("maintenance");
      return restartReceipt(context);
    },
  };
}

const rendererCurrent = manifest("release-1", [
  { path: "renderer/index.html", role: "renderer", sha256: "1".repeat(64) },
]);
const rendererCandidate = manifest("release-2", [
  { path: "renderer/index.html", role: "renderer", sha256: "2".repeat(64) },
]);

describe("LayeredUpdateOrchestrator", () => {
  it("plans and dispatches each release to its least disruptive handler", async () => {
    const order: string[] = [];
    let now = 100;
    const orchestrator = new LayeredUpdateOrchestrator({
      handlers: handlers(order),
      now: () => now++,
    });

    const renderer = await orchestrator.execute({
      updateId: "update-renderer",
      current: rendererCurrent,
      candidate: rendererCandidate,
    });
    expect(renderer).toMatchObject({
      mode: "renderer-reload",
      outcome: "committed",
      currentReleaseId: "release-1",
      candidateReleaseId: "release-2",
    });

    const runtime = await orchestrator.execute({
      updateId: "update-runtime",
      current: manifest("runtime-1", [
        {
          path: "runtime/host.cjs",
          role: "runtime-host",
          sha256: "1".repeat(64),
        },
      ]),
      candidate: manifest("runtime-2", [
        {
          path: "runtime/host.cjs",
          role: "runtime-host",
          sha256: "2".repeat(64),
        },
      ]),
    });
    expect(runtime.mode).toBe("runtime-rolling");

    const restart = await orchestrator.execute({
      updateId: "update-shell",
      current: manifest("shell-1", [
        {
          path: "shell/app.exe",
          role: "desktop-shell",
          sha256: "1".repeat(64),
        },
      ]),
      candidate: manifest("shell-2", [
        {
          path: "shell/app.exe",
          role: "desktop-shell",
          sha256: "2".repeat(64),
        },
      ]),
    });
    expect(restart.mode).toBe("application-restart");

    const maintenance = await orchestrator.execute({
      updateId: "update-database",
      current: manifest("database-1", [
        {
          path: "database/schema.sql",
          role: "database",
          sha256: "1".repeat(64),
        },
      ]),
      candidate: manifest("database-2", [
        {
          path: "database/schema.sql",
          role: "database",
          sha256: "2".repeat(64),
        },
      ]),
      policy: { databaseMigration: "contract" },
    });
    expect(maintenance.mode).toBe("maintenance");
    expect(order).toEqual(["renderer", "runtime", "restart", "maintenance"]);
  });

  it("returns no-op without invoking a handler for unchanged or dry-run candidates", async () => {
    const order: string[] = [];
    const orchestrator = new LayeredUpdateOrchestrator({
      handlers: handlers(order),
    });
    const unchanged = await orchestrator.execute({
      updateId: "update-no-op",
      current: rendererCurrent,
      candidate: manifest("release-2", [
        {
          path: "renderer/index.html",
          role: "renderer",
          sha256: "1".repeat(64),
        },
      ]),
    });
    expect(unchanged).toMatchObject({ mode: "no-op", outcome: "no-op" });

    const dryRun = await orchestrator.execute({
      updateId: "update-dry-run",
      current: rendererCurrent,
      candidate: rendererCandidate,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      mode: "renderer-reload",
      outcome: "no-op",
      detail: null,
    });
    expect(order).toEqual([]);
  });

  it("rejects a stale expected strategy before any handler runs", async () => {
    const order: string[] = [];
    const orchestrator = new LayeredUpdateOrchestrator({
      handlers: handlers(order),
    });
    await expect(
      orchestrator.execute({
        updateId: "update-stale-plan",
        current: rendererCurrent,
        candidate: rendererCandidate,
        expectedMode: "runtime-rolling",
      }),
    ).rejects.toThrow(/mode changed/u);
    expect(order).toEqual([]);
  });

  it("converts handler failures and mismatched receipts into failed update receipts", async () => {
    const failing = new LayeredUpdateOrchestrator({
      handlers: {
        ...handlers([]),
        rendererReload: async () => {
          throw new Error("candidate webview failed readiness");
        },
      },
    });
    await expect(
      failing.execute({
        updateId: "update-handler-failure",
        current: rendererCurrent,
        candidate: rendererCandidate,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      failureReason: "candidate webview failed readiness",
      detail: null,
    });

    const mismatched = new LayeredUpdateOrchestrator({
      handlers: {
        ...handlers([]),
        rendererReload: async (context) => ({
          ...rendererReceipt(context),
          candidateReleaseId: "another-release",
        }),
      },
    });
    await expect(
      mismatched.execute({
        updateId: "update-mismatched-receipt",
        current: rendererCurrent,
        candidate: rendererCandidate,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      failureReason: expect.stringMatching(/another candidate/u),
      detail: null,
    });
  });

  it("rejects concurrent executions instead of queueing a stale release plan", async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const base = handlers([]);
    const orchestrator = new LayeredUpdateOrchestrator({
      handlers: {
        ...base,
        rendererReload: async (context) => {
          await handlerGate;
          return rendererReceipt(context);
        },
      },
    });
    const first = orchestrator.execute({
      updateId: "update-first",
      current: rendererCurrent,
      candidate: rendererCandidate,
    });
    await Promise.resolve();

    expect(orchestrator.busy).toBe(true);
    await expect(
      orchestrator.execute({
        updateId: "update-second",
        current: rendererCurrent,
        candidate: rendererCandidate,
      }),
    ).rejects.toBeInstanceOf(LayeredUpdateBusyError);

    releaseHandler();
    await expect(first).resolves.toMatchObject({ outcome: "committed" });
  });

  it("honors pre-aborted requests and ignores planning telemetry failures", async () => {
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    const orchestrator = new LayeredUpdateOrchestrator({
      handlers: handlers([]),
      onPlan: () => {
        throw new Error("telemetry unavailable");
      },
    });
    await expect(
      orchestrator.execute({
        updateId: "update-aborted",
        current: rendererCurrent,
        candidate: rendererCandidate,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted before planning/u);

    await expect(
      orchestrator.execute({
        updateId: "update-telemetry",
        current: rendererCurrent,
        candidate: rendererCandidate,
      }),
    ).resolves.toMatchObject({ outcome: "committed" });
  });
});
