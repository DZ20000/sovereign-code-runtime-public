import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LayeredUpdateJournal,
  executeLayeredUpdateWithJournal,
  type LayeredUpdateJournalRecord,
} from "../src/layered-update-journal.js";
import {
  LayeredUpdateCoordinator,
  type LayeredUpdateReceipt,
  type VerifiedLayeredUpdateCandidate,
} from "../src/layered-update.js";
import { planComponentUpdate } from "../src/update-plan.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scr-layered-update-journal-"));
  roots.push(root);
  return root;
}

function receipt(
  operationId: string,
  overrides: Partial<LayeredUpdateReceipt> = {},
): LayeredUpdateReceipt {
  const plan = planComponentUpdate([
    {
      path: "renderer/index.html",
      role: "renderer",
      change: "modified",
    },
  ]);
  return {
    operationId,
    releaseId: `release-${operationId.replaceAll(":", "-")}`,
    releaseSequence: 42,
    manifestSha256: "a".repeat(64),
    signingKeyId: "key-1",
    strategy: "renderer-reload",
    plan,
    outcome: "committed",
    delegatedReceipt: null,
    failureReason: null,
    startedAt: 100,
    completedAt: 200,
    transitions: [
      {
        operationId,
        releaseId: `release-${operationId.replaceAll(":", "-")}`,
        releaseSequence: 42,
        phase: "planned",
        strategy: "renderer-reload",
        at: 100,
      },
      {
        operationId,
        releaseId: `release-${operationId.replaceAll(":", "-")}`,
        releaseSequence: 42,
        phase: "committed",
        strategy: "renderer-reload",
        at: 200,
      },
    ],
    ...overrides,
  };
}

async function recordFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
}

describe("LayeredUpdateJournal", () => {
  it("appends an immutable contiguous SHA-256 chain", async () => {
    const root = await temporaryRoot();
    let now = 1_000;
    const journal = new LayeredUpdateJournal({
      directory: root,
      now: () => now++,
    });

    const first = await journal.append(receipt("update:one"));
    const second = await journal.append(
      receipt("update:two", {
        releaseId: "release-two",
        releaseSequence: 43,
        manifestSha256: "b".repeat(64),
      }),
    );

    expect(first).toMatchObject({
      sequence: 1,
      previousRecordSha256: null,
      recordedAt: 1_000,
    });
    expect(second).toMatchObject({
      sequence: 2,
      previousRecordSha256: first.recordSha256,
      recordedAt: 1_001,
    });
    expect(second.recordSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(journal.list()).resolves.toEqual([first, second]);
    await expect(journal.latest()).resolves.toEqual(second);

    const files = await recordFiles(root);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^000000000001-[a-f0-9]{16}\.json$/u);
    expect(files.join("\n")).not.toContain(":");
  });

  it("is idempotent for identical operation evidence and rejects divergence", async () => {
    const root = await temporaryRoot();
    const journal = new LayeredUpdateJournal({ directory: root });
    const original = receipt("update:idempotent");

    const first = await journal.append(original);
    const second = await journal.append(original);
    expect(second).toEqual(first);

    await expect(
      journal.append(
        receipt("update:idempotent", {
          manifestSha256: "c".repeat(64),
        }),
      ),
    ).rejects.toThrow(/different evidence/u);
    await expect(journal.list()).resolves.toHaveLength(1);
  });

  it("serializes concurrent writers across journal instances", async () => {
    const root = await temporaryRoot();
    const left = new LayeredUpdateJournal({ directory: root });
    const right = new LayeredUpdateJournal({ directory: root });

    const records = await Promise.all([
      left.append(receipt("update:left")),
      right.append(
        receipt("update:right", {
          releaseId: "release-right",
          releaseSequence: 43,
          manifestSha256: "d".repeat(64),
        }),
      ),
    ]);

    expect(records.map((record) => record.sequence).sort()).toEqual([1, 2]);
    const loaded = await left.list();
    expect(loaded).toHaveLength(2);
    expect(loaded[1]?.previousRecordSha256).toBe(loaded[0]?.recordSha256);
  });

  it("detects record tampering and hash-chain gaps", async () => {
    const root = await temporaryRoot();
    const journal = new LayeredUpdateJournal({ directory: root });
    await journal.append(receipt("update:first"));
    await journal.append(
      receipt("update:second", {
        releaseId: "release-second",
        releaseSequence: 43,
      }),
    );
    const files = await recordFiles(root);
    const firstPath = join(root, files[0]!);
    const first = JSON.parse(
      await readFile(firstPath, "utf8"),
    ) as LayeredUpdateJournalRecord;
    await writeFile(
      firstPath,
      `${JSON.stringify({
        ...first,
        payload: { ...first.payload, releaseSequence: 999 },
      })}\n`,
      "utf8",
    );
    await expect(journal.list()).rejects.toThrow(/digest does not match/u);

    const cleanRoot = await temporaryRoot();
    const clean = new LayeredUpdateJournal({ directory: cleanRoot });
    await clean.append(receipt("update:gap-one"));
    await clean.append(
      receipt("update:gap-two", {
        releaseId: "release-gap-two",
        releaseSequence: 43,
      }),
    );
    const cleanFiles = await recordFiles(cleanRoot);
    await rename(
      join(cleanRoot, cleanFiles[1]!),
      join(cleanRoot, cleanFiles[1]!.replace("000000000002", "000000000003")),
    );
    await expect(clean.list()).rejects.toThrow(/not contiguous/u);
  });

  it("rejects unexpected entries and clears abandoned pending files", async () => {
    const root = await temporaryRoot();
    const journal = new LayeredUpdateJournal({ directory: root });
    await writeFile(
      join(root, ".pending-000000000001-10.tmp"),
      "partial",
      "utf8",
    );
    await expect(journal.list()).resolves.toEqual([]);
    expect(await readdir(root)).not.toContain(".pending-000000000001-10.tmp");

    await writeFile(join(root, "notes.txt"), "unexpected", "utf8");
    await expect(journal.list()).rejects.toThrow(/unexpected entry/u);
  });

  it("sanitizes and bounds failure evidence before persistence", async () => {
    const root = await temporaryRoot();
    const journal = new LayeredUpdateJournal({ directory: root });
    const value = await journal.append(
      receipt("update:failed", {
        outcome: "failed",
        failureReason: `bad\nreason\0${"x".repeat(2_000)}`,
      }),
    );

    expect(value.payload.failureReason).not.toMatch(/[\n\0]/u);
    expect(value.payload.failureReason?.length).toBeLessThanOrEqual(1_024);
  });

  it("journals a completed cutover without changing its authoritative outcome", async () => {
    const root = await temporaryRoot();
    const journal = new LayeredUpdateJournal({
      directory: root,
      now: () => 300,
    });
    const coordinator = new LayeredUpdateCoordinator({
      now: () => 200,
      adapter: {
        renderer: {
          cutover: async (input) => ({
            cutoverId: input.cutoverId,
            outcome: "committed",
            previousReleaseId: "renderer-1",
            candidateReleaseId: input.candidateReleaseId,
            previousGeneration: 1,
            finalGeneration: 2,
            stateBytes: 16,
            startedAt: 200,
            completedAt: 201,
            failureReason: null,
            cleanupFailures: [],
            phases: [],
          }),
        },
        executeRestart: async () => ({
          outcome: "failed",
          failureReason: "restart path must not run",
          receiptId: null,
        }),
      },
    });
    const candidate: VerifiedLayeredUpdateCandidate = {
      releaseId: "release-journaled",
      releaseSequence: 50,
      manifestSha256: "e".repeat(64),
      signingKeyId: "key-journaled",
      verifiedAt: 200,
      changes: [
        {
          path: "renderer/index.html",
          role: "renderer",
          change: "modified",
        },
      ],
      renderer: { candidateReleaseId: "renderer-2", expectedGeneration: 1 },
    };

    const result = await executeLayeredUpdateWithJournal(
      coordinator,
      journal,
      candidate,
    );

    expect(result).toMatchObject({
      receipt: { outcome: "committed", strategy: "renderer-reload" },
      journalRecord: { sequence: 1 },
      journalFailure: null,
    });
    await expect(journal.list()).resolves.toHaveLength(1);
  });

  it("reports journal failure separately instead of retrying an already committed cutover", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "unexpected.txt"), "blocks journal", "utf8");
    const journal = new LayeredUpdateJournal({ directory: root });
    let cutoverCalls = 0;
    const coordinator = new LayeredUpdateCoordinator({
      now: () => 200,
      adapter: {
        renderer: {
          cutover: async (input) => {
            cutoverCalls += 1;
            return {
              cutoverId: input.cutoverId,
              outcome: "committed",
              previousReleaseId: "renderer-1",
              candidateReleaseId: input.candidateReleaseId,
              previousGeneration: 1,
              finalGeneration: 2,
              stateBytes: 0,
              startedAt: 200,
              completedAt: 201,
              failureReason: null,
              cleanupFailures: [],
              phases: [],
            };
          },
        },
        executeRestart: async () => ({
          outcome: "failed",
          failureReason: "restart path must not run",
          receiptId: null,
        }),
      },
    });
    const candidate: VerifiedLayeredUpdateCandidate = {
      releaseId: "release-journal-failure",
      releaseSequence: 51,
      manifestSha256: "f".repeat(64),
      signingKeyId: "key-journaled",
      verifiedAt: 200,
      changes: [
        {
          path: "renderer/index.html",
          role: "renderer",
          change: "modified",
        },
      ],
      renderer: { candidateReleaseId: "renderer-2" },
    };

    const result = await executeLayeredUpdateWithJournal(
      coordinator,
      journal,
      candidate,
    );

    expect(cutoverCalls).toBe(1);
    expect(result.receipt.outcome).toBe("committed");
    expect(result.journalRecord).toBeNull();
    expect(result.journalFailure).toMatch(/unexpected entry/u);
  });
  it("hashes delegated receipts and transitions rather than storing their full contents", async () => {
    const root = await temporaryRoot();
    const journal = new LayeredUpdateJournal({ directory: root });
    const value = await journal.append(
      receipt("update:delegated", {
        delegatedReceipt: {
          cutoverId: "renderer-cutover",
          outcome: "committed",
          previousReleaseId: "renderer-1",
          candidateReleaseId: "renderer-2",
          previousGeneration: 1,
          finalGeneration: 2,
          stateBytes: 128,
          startedAt: 100,
          completedAt: 200,
          failureReason: null,
          cleanupFailures: [],
          phases: [],
        },
      }),
    );

    expect(value.payload.delegatedReceiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.payload.transitionsSha256).toMatch(/^[a-f0-9]{64}$/u);
    const file = await readFile(
      join(root, (await recordFiles(root))[0]!),
      "utf8",
    );
    expect(file).not.toContain("renderer-cutover");
  });
});
