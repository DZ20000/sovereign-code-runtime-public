import { describe, expect, it } from "vitest";
import {
  LayeredUpdateBusyError,
  LayeredUpdateCoordinator,
  type LayeredUpdateAdapter,
  type RestartUpdateReceipt,
  type VerifiedLayeredUpdateCandidate,
} from "../src/layered-update.js";
import type { RendererCutoverReceipt } from "../src/renderer-cutover.js";
import type { RuntimeCutoverReceipt } from "../src/runtime-cutover.js";

const NOW = 1_000_000;

type CandidateOverrides = Omit<
  Partial<VerifiedLayeredUpdateCandidate>,
  "renderer"
> & {
  readonly renderer?: VerifiedLayeredUpdateCandidate["renderer"] | undefined;
};

function candidate(
  overrides: CandidateOverrides = {},
): VerifiedLayeredUpdateCandidate {
  const { renderer, ...remaining } = overrides;
  const hasRendererOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "renderer",
  );
  return {
    releaseId: "release-42",
    releaseSequence: 42,
    manifestSha256: "a".repeat(64),
    signingKeyId: "release-key-1",
    verifiedAt: NOW,
    changes: [
      {
        path: "renderer/assets/main.js",
        role: "renderer",
        change: "modified",
      },
    ],
    ...remaining,
    ...(hasRendererOverride
      ? renderer === undefined
        ? {}
        : { renderer }
      : {
          renderer: {
            candidateReleaseId: "renderer-42",
            expectedGeneration: 7,
          },
        }),
  };
}

function rendererReceipt(
  outcome: RendererCutoverReceipt["outcome"] = "committed",
): RendererCutoverReceipt {
  return {
    cutoverId: "ignored-by-fake",
    outcome,
    previousReleaseId: "renderer-41",
    candidateReleaseId: "renderer-42",
    previousGeneration: 7,
    finalGeneration: outcome === "committed" ? 8 : 9,
    stateBytes: 128,
    startedAt: NOW,
    completedAt: NOW + 1,
    failureReason: outcome === "committed" ? null : "candidate failed",
    cleanupFailures: [],
    phases: [],
  };
}

function runtimeReceipt(
  outcome: RuntimeCutoverReceipt["outcome"] = "committed",
): RuntimeCutoverReceipt {
  return {
    cutoverId: "ignored-by-fake",
    outcome,
    activeReleaseId: "runtime-41",
    candidateReleaseId: "runtime-42",
    previousInstanceId: "host-active",
    candidateInstanceId: "host-candidate",
    checkpointId: "checkpoint-42",
    startedAt: NOW,
    completedAt: NOW + 1,
    failureReason: outcome === "committed" ? null : "canary failed",
    cleanupFailures: [],
    phases: [],
  };
}

function restartReceipt(
  outcome: RestartUpdateReceipt["outcome"] = "restart-required",
): RestartUpdateReceipt {
  return {
    outcome,
    failureReason: outcome === "failed" ? "restart staging failed" : null,
    receiptId: "restart-receipt-42",
  };
}

function adapter(
  overrides: Partial<LayeredUpdateAdapter> = {},
): LayeredUpdateAdapter {
  return {
    renderer: {
      cutover: async () => rendererReceipt(),
    },
    runtime: {
      cutover: async () => runtimeReceipt(),
    },
    executeRestart: async () => restartReceipt(),
    ...overrides,
  };
}

describe("LayeredUpdateCoordinator", () => {
  it("routes renderer-only releases to the renderer cutover", async () => {
    const calls: string[] = [];
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter({
        renderer: {
          cutover: async (input) => {
            calls.push(`${input.cutoverId}:${input.candidateReleaseId}`);
            expect(input.expectedGeneration).toBe(7);
            expect(input.signal).toBeInstanceOf(AbortSignal);
            return rendererReceipt();
          },
        },
        runtime: {
          cutover: async () => {
            throw new Error("runtime path must not run");
          },
        },
        executeRestart: async () => {
          throw new Error("restart path must not run");
        },
      }),
      now: () => NOW,
    });

    const receipt = await coordinator.execute(candidate(), {
      operationId: "layered-renderer-42",
    });

    expect(receipt).toMatchObject({
      strategy: "renderer-reload",
      outcome: "committed",
      failureReason: null,
    });
    expect(calls).toEqual(["layered-renderer-42:renderer-42"]);
    expect(receipt.transitions.map((transition) => transition.phase)).toEqual([
      "planned",
      "delegated",
      "committed",
    ]);
  });

  it("routes Runtime Host and Gateway changes to a rolling cutover", async () => {
    const calls: string[] = [];
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter({
        runtime: {
          cutover: async (input) => {
            calls.push(`${input.cutoverId}:${input.candidate.releaseId}`);
            return runtimeReceipt("rolled-back");
          },
        },
      }),
      now: () => NOW,
    });

    const receipt = await coordinator.execute(
      candidate({
        changes: [
          {
            path: "runtime/runtime-host.cjs",
            role: "runtime-host",
            change: "modified",
          },
          {
            path: "runtime/gateway.cjs",
            role: "gateway",
            change: "modified",
          },
        ],
        renderer: undefined,
        runtime: {
          active: { instanceId: "host-active", releaseId: "runtime-41" },
          candidate: {
            releaseId: "runtime-42",
            directory: "releases/runtime-42",
            manifestSha256: "b".repeat(64),
          },
        },
      }),
      { operationId: "layered-runtime-42" },
    );

    expect(receipt).toMatchObject({
      strategy: "runtime-rolling",
      outcome: "rolled-back",
      failureReason: "canary failed",
    });
    expect(calls).toEqual(["layered-runtime-42:runtime-42"]);
  });

  it("delegates native and unknown component changes to controlled restart", async () => {
    const maintenanceFlags: boolean[] = [];
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter({
        executeRestart: async (request) => {
          maintenanceFlags.push(request.maintenance);
          expect(request.signal).toBeInstanceOf(AbortSignal);
          return restartReceipt();
        },
      }),
      now: () => NOW,
    });

    const native = await coordinator.execute(
      candidate({
        changes: [
          {
            path: "shell/Sovereign.exe",
            role: "desktop-shell",
            change: "modified",
          },
        ],
        renderer: undefined,
      }),
    );
    const unknown = await coordinator.execute(
      candidate({
        releaseId: "release-43",
        releaseSequence: 43,
        changes: [
          {
            path: "future/component.bin",
            role: "future-component",
            change: "added",
          },
        ],
        renderer: undefined,
      }),
    );

    expect(native).toMatchObject({
      strategy: "application-restart",
      outcome: "restart-required",
    });
    expect(unknown).toMatchObject({
      strategy: "application-restart",
      outcome: "restart-required",
    });
    expect(maintenanceFlags).toEqual([false, false]);
  });

  it("routes contract migrations to maintenance without pretending they are live", async () => {
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter({
        executeRestart: async (request) => {
          expect(request.maintenance).toBe(true);
          expect(request.plan.mode).toBe("maintenance");
          return restartReceipt();
        },
      }),
      now: () => NOW,
    });

    const receipt = await coordinator.execute(
      candidate({
        changes: [
          {
            path: "database/tasks.sqlite.sql",
            role: "database",
            change: "modified",
          },
        ],
        policy: { databaseMigration: "contract" },
        renderer: undefined,
      }),
    );

    expect(receipt).toMatchObject({
      strategy: "maintenance",
      outcome: "maintenance-required",
    });
  });

  it("returns no-op without invoking any adapter", async () => {
    const coordinator = new LayeredUpdateCoordinator({
      adapter: {
        executeRestart: async () => {
          throw new Error("no-op must not delegate");
        },
      },
      now: () => NOW,
    });

    const receipt = await coordinator.execute(
      candidate({ changes: [], renderer: undefined }),
    );

    expect(receipt).toMatchObject({
      strategy: "no-op",
      outcome: "no-op",
      delegatedReceipt: null,
    });
    expect(receipt.transitions.map((transition) => transition.phase)).toEqual([
      "planned",
      "no-op",
    ]);
  });

  it("fails closed when the selected live adapter input is unavailable", async () => {
    const coordinator = new LayeredUpdateCoordinator({
      adapter: {
        executeRestart: async () => restartReceipt(),
      },
      now: () => NOW,
    });

    const receipt = await coordinator.execute(
      candidate({ renderer: undefined }),
    );

    expect(receipt).toMatchObject({
      strategy: "renderer-reload",
      outcome: "failed",
      delegatedReceipt: null,
    });
    expect(receipt.failureReason).toMatch(/missing a renderer candidate/u);
  });

  it("rejects stale or malformed verification evidence before delegation", async () => {
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter(),
      now: () => NOW,
    });

    await expect(
      coordinator.execute(
        candidate({ verifiedAt: NOW - 24 * 60 * 60_000 - 1 }),
      ),
    ).rejects.toThrow(/stale or invalid/u);
    await expect(
      coordinator.execute(candidate({ manifestSha256: "not-a-digest" })),
    ).rejects.toThrow(/manifest digest/u);
  });

  it("propagates cancellation into the delegated live mechanism", async () => {
    const controller = new AbortController();
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter({
        renderer: {
          cutover: async (input) => {
            controller.abort(new Error("operator cancelled"));
            await Promise.resolve();
            expect(input.signal?.aborted).toBe(true);
            throw input.signal?.reason;
          },
        },
      }),
      now: () => NOW,
    });

    const receipt = await coordinator.execute(candidate(), {
      signal: controller.signal,
    });

    expect(receipt.outcome).toBe("failed");
    expect(receipt.failureReason).toMatch(/operator cancelled/u);
  });

  it("rejects concurrent executions instead of queueing a stale verified candidate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter({
        renderer: {
          cutover: async () => {
            await gate;
            return rendererReceipt();
          },
        },
      }),
      now: () => NOW,
    });

    const first = coordinator.execute(candidate(), {
      operationId: "layered-first",
    });
    await Promise.resolve();
    expect(coordinator.busy).toBe(true);
    await expect(
      coordinator.execute(candidate({ releaseId: "release-43" }), {
        operationId: "layered-second",
      }),
    ).rejects.toBeInstanceOf(LayeredUpdateBusyError);

    release();
    await expect(first).resolves.toMatchObject({ outcome: "committed" });
    expect(coordinator.busy).toBe(false);
  });

  it("ignores transition observer failures", async () => {
    const coordinator = new LayeredUpdateCoordinator({
      adapter: adapter(),
      now: () => NOW,
      onTransition: () => {
        throw new Error("telemetry unavailable");
      },
    });

    await expect(coordinator.execute(candidate())).resolves.toMatchObject({
      outcome: "committed",
    });
  });
});
