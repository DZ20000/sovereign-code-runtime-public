import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION,
  CutoverLedger,
  type CutoverLedgerEntry,
} from "../src/cutover-ledger.js";
import type {
  RendererCutoverReceipt,
  RendererCutoverTransition,
} from "../src/renderer-cutover.js";
import type {
  RuntimeCutoverReceipt,
  RuntimeCutoverTransition,
} from "../src/runtime-cutover.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly ledger: CutoverLedger;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-cutover-ledger-"));
  roots.push(root);
  return {
    root,
    ledger: new CutoverLedger({ rootDirectory: root }),
  };
}

function runtimeTransition(
  phase: RuntimeCutoverTransition["phase"],
  overrides: Partial<RuntimeCutoverTransition> = {},
): RuntimeCutoverTransition {
  return {
    cutoverId: "runtime-cutover-1",
    phase,
    at: 100,
    activeInstanceId: "runtime-active-1",
    candidateInstanceId: "runtime-candidate-2",
    ...overrides,
  };
}

function rendererTransition(
  phase: RendererCutoverTransition["phase"],
  overrides: Partial<RendererCutoverTransition> = {},
): RendererCutoverTransition {
  return {
    cutoverId: "renderer-cutover-1",
    phase,
    at: 100,
    previousReleaseId: "renderer-release-1",
    candidateReleaseId: "renderer-release-2",
    generation: 2,
    ...overrides,
  };
}

function runtimeReceipt(
  outcome: RuntimeCutoverReceipt["outcome"] = "committed",
): RuntimeCutoverReceipt {
  return {
    cutoverId: "runtime-cutover-1",
    outcome,
    activeReleaseId: "runtime-release-1",
    candidateReleaseId: "runtime-release-2",
    previousInstanceId: "runtime-active-1",
    candidateInstanceId: "runtime-candidate-2",
    checkpointId: "checkpoint-1",
    startedAt: 100,
    completedAt: 200,
    failureReason: outcome === "committed" ? null : "candidate rejected",
    cleanupFailures: [],
    phases: [],
  };
}

function rendererReceipt(
  outcome: RendererCutoverReceipt["outcome"] = "committed",
): RendererCutoverReceipt {
  return {
    cutoverId: "renderer-cutover-1",
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

describe("CutoverLedger", () => {
  it("appends a contiguous SHA-256 chain and closes a cutover with its receipt", async () => {
    const { ledger } = await fixture();
    await ledger.appendRuntimeTransition(runtimeTransition("start-candidate"), {
      activeReleaseId: "runtime-release-1",
      candidateReleaseId: "runtime-release-2",
    });
    await ledger.appendRuntimeTransition(
      runtimeTransition("candidate-health"),
      {
        activeReleaseId: "runtime-release-1",
        candidateReleaseId: "runtime-release-2",
      },
    );
    await ledger.appendRuntimeReceipt(runtimeReceipt());

    const entries = await ledger.readAll();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(entries[0]?.previousEntrySha256).toBeNull();
    expect(entries[1]?.previousEntrySha256).toBe(entries[0]?.entrySha256);
    expect(entries[2]?.previousEntrySha256).toBe(entries[1]?.entrySha256);
    expect(entries[2]?.payload).toMatchObject({
      recordType: "receipt",
      outcome: "committed",
      checkpointId: "checkpoint-1",
    });
    await expect(ledger.recoveryPlans()).resolves.toEqual([]);
  });

  it("serializes concurrent writers across ledger instances", async () => {
    const { root } = await fixture();
    const left = new CutoverLedger({ rootDirectory: root });
    const right = new CutoverLedger({ rootDirectory: root });
    await Promise.all([
      left.appendRendererTransition(
        rendererTransition("verify-candidate", {
          cutoverId: "renderer-left",
        }),
      ),
      right.appendRendererTransition(
        rendererTransition("verify-candidate", {
          cutoverId: "renderer-right",
          candidateReleaseId: "renderer-release-3",
        }),
      ),
    ]);

    const entries = await left.readAll();
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(new Set(entries.map((entry) => entry.payload.cutoverId))).toEqual(
      new Set(["renderer-left", "renderer-right"]),
    );
  });

  it("detects payload tampering, filename tampering, and hash-chain gaps", async () => {
    const { root, ledger } = await fixture();
    await ledger.appendRendererTransition(
      rendererTransition("verify-candidate"),
    );
    await ledger.appendRendererTransition(
      rendererTransition("preflight-candidate"),
    );
    const directory = join(root, "entries");
    const files = (await readdir(directory)).sort();

    const secondPath = join(directory, files[1]!);
    const second = JSON.parse(
      await readFile(secondPath, "utf8"),
    ) as CutoverLedgerEntry;
    await writeFile(
      secondPath,
      `${JSON.stringify({
        ...second,
        payload: {
          ...second.payload,
          candidateReleaseId: "renderer-release-tampered",
        },
      })}\n`,
      "utf8",
    );
    await expect(ledger.readAll()).rejects.toThrow(/digest does not match/u);

    await rm(secondPath);
    await expect(ledger.readAll()).resolves.toHaveLength(1);
    const firstName = files[0]!;
    const badName = join(
      directory,
      `00000000000000000001-${"0".repeat(16)}.json`,
    );
    await writeFile(badName, await readFile(join(directory, firstName)));
    await rm(join(directory, firstName));
    await expect(ledger.readAll()).rejects.toThrow(/filename does not match/u);
  });

  it("fails closed on unknown directory entries and linked ledger files", async () => {
    const { root, ledger } = await fixture();
    await ledger.appendRendererTransition(
      rendererTransition("verify-candidate"),
    );
    const directory = join(root, "entries");
    await mkdir(join(directory, "unexpected-directory"));
    await expect(ledger.readAll()).rejects.toThrow(/unexpected entry/u);
  });

  it("plans recovery from every consequential Runtime Host boundary", async () => {
    const scenarios = [
      ["candidate-health", "stop-candidate"],
      ["drain-active", "resume-active-and-stop-candidate"],
      ["candidate-canary", "rollback-traffic-resume-active-stop-candidate"],
      ["commit-candidate", "finish-commit-cleanup"],
      ["committed", "verify-terminal-state"],
    ] as const;

    for (const [phase, expectedAction] of scenarios) {
      const { ledger } = await fixture();
      await ledger.appendRuntimeTransition(runtimeTransition(phase), {
        activeReleaseId: "runtime-release-1",
        candidateReleaseId: "runtime-release-2",
      });
      await expect(ledger.recoveryPlans()).resolves.toEqual([
        expect.objectContaining({
          kind: "runtime",
          action: expectedAction,
          lastPhase: phase,
        }),
      ]);
    }
  });

  it("plans renderer rollback only after the active pointer may have changed", async () => {
    const scenarios = [
      ["preflight-candidate", "none"],
      ["activate-candidate", "rollback-renderer"],
      ["candidate-ready", "rollback-renderer"],
      ["rollback-pointer", "finish-renderer-rollback"],
      ["rolled-back", "verify-terminal-state"],
    ] as const;

    for (const [phase, expectedAction] of scenarios) {
      const { ledger } = await fixture();
      await ledger.appendRendererTransition(rendererTransition(phase));
      await expect(ledger.recoveryPlans()).resolves.toEqual([
        expect.objectContaining({
          kind: "renderer",
          action: expectedAction,
          lastPhase: phase,
        }),
      ]);
    }
  });

  it("records coordinator callbacks in order before the durable receipt", async () => {
    const { ledger } = await fixture();
    const recorder = ledger.createRecorder();
    recorder.runtimeTransition(runtimeTransition("start-candidate"), {
      activeReleaseId: "runtime-release-1",
      candidateReleaseId: "runtime-release-2",
    });
    recorder.runtimeTransition(runtimeTransition("candidate-health"), {
      activeReleaseId: "runtime-release-1",
      candidateReleaseId: "runtime-release-2",
    });
    await recorder.recordRuntimeReceipt(runtimeReceipt("rolled-back"));

    const entries = await ledger.readAll();
    expect(entries.map((entry) => entry.payload.recordType)).toEqual([
      "transition",
      "transition",
      "receipt",
    ]);
    expect(entries.at(-1)?.payload.outcome).toBe("rolled-back");
  });

  it("validates payload shape before writing any durable bytes", async () => {
    const { ledger } = await fixture();
    await expect(
      ledger.append({
        kind: "renderer",
        recordType: "transition",
        cutoverId: "renderer-invalid",
        phase: "activate-candidate",
        outcome: null,
        activeReleaseId: "renderer-release-1",
        candidateReleaseId: "renderer-release-2",
        activeInstanceId: "not-allowed",
        candidateInstanceId: null,
        generation: 2,
        checkpointId: null,
        failureReason: null,
        cleanupFailures: [],
      }),
    ).rejects.toThrow(/inconsistent/u);
    await expect(ledger.readAll()).resolves.toEqual([]);
  });

  it("rejects records after a receipt and identity drift within one cutover", async () => {
    const { ledger } = await fixture();
    await ledger.appendRuntimeTransition(runtimeTransition("start-candidate"), {
      activeReleaseId: "runtime-release-1",
      candidateReleaseId: "runtime-release-2",
    });
    await ledger.appendRuntimeReceipt(runtimeReceipt());
    await expect(
      ledger.appendRuntimeTransition(runtimeTransition("candidate-health"), {
        activeReleaseId: "runtime-release-1",
        candidateReleaseId: "runtime-release-2",
      }),
    ).rejects.toThrow(/after the receipt/u);

    const second = await fixture();
    await second.ledger.appendRendererTransition(
      rendererTransition("verify-candidate"),
    );
    await expect(
      second.ledger.appendRendererTransition(
        rendererTransition("preflight-candidate", {
          candidateReleaseId: "renderer-release-different",
        }),
      ),
    ).rejects.toThrow(/identity changed/u);
    await expect(
      second.ledger.appendRendererTransition(
        rendererTransition("activate-candidate", { generation: 1 }),
      ),
    ).rejects.toThrow(/moved backwards/u);
  });

  it("does not steal a fresh malformed lock but recovers a stale abandoned lock", async () => {
    const { root } = await fixture();
    await mkdir(root, { recursive: true });
    const lockPath = join(root, "ledger.lock");
    await writeFile(lockPath, "partially-written", "utf8");
    const guarded = new CutoverLedger({
      rootDirectory: root,
      lockTimeoutMs: 30,
      staleLockMs: 60_000,
    });
    await expect(
      guarded.appendRendererTransition(rendererTransition("verify-candidate")),
    ).rejects.toThrow(/Timed out waiting/u);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("partially-written");

    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);
    const recovering = new CutoverLedger({
      rootDirectory: root,
      lockTimeoutMs: 1_000,
      staleLockMs: 10,
    });
    await expect(
      recovering.appendRendererTransition(
        rendererTransition("verify-candidate"),
      ),
    ).resolves.toMatchObject({ sequence: 1 });
  });
  it("writes canonical bounded entry envelopes", async () => {
    const { root, ledger } = await fixture();
    const entry = await ledger.appendRendererTransition(
      rendererTransition("verify-candidate"),
    );
    expect(entry.schemaVersion).toBe(CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION);
    const [file] = await readdir(join(root, "entries"));
    const bytes = await readFile(join(root, "entries", file!), "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.length).toBeLessThan(128 * 1_024);
  });

  it("also closes renderer cutovers with renderer receipts", async () => {
    const { ledger } = await fixture();
    await ledger.appendRendererTransition(
      rendererTransition("activate-candidate"),
    );
    await ledger.appendRendererReceipt(rendererReceipt("rolled-back"));
    await expect(ledger.recoveryPlans()).resolves.toEqual([]);
  });
});
