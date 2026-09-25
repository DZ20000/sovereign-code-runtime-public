import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LayeredCutoverJournal,
  type LayeredCutoverIdentity,
} from "../src/layered-cutover-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(nowStart = 100) {
  const root = await mkdtemp(join(tmpdir(), "scr-cutover-journal-"));
  roots.push(root);
  let now = nowStart;
  return {
    root,
    journal: new LayeredCutoverJournal({
      rootDirectory: root,
      now: () => now++,
    }),
  };
}

const runtimeIdentity: LayeredCutoverIdentity = {
  cutoverId: "runtime-cutover-1",
  kind: "runtime",
  activeReleaseId: "release-1",
  candidateReleaseId: "release-2",
};

const rendererIdentity: LayeredCutoverIdentity = {
  cutoverId: "renderer-cutover-1",
  kind: "renderer",
  activeReleaseId: "renderer-1",
  candidateReleaseId: "renderer-2",
};

describe("LayeredCutoverJournal", () => {
  it("writes a contiguous hash-chained journal and closes it once", async () => {
    const { journal } = await fixture();
    await journal.begin(runtimeIdentity, { manifestSha256: "a".repeat(64) });
    await journal.transition(runtimeIdentity.cutoverId, {
      phase: "start-candidate",
      details: { instanceId: "candidate-2" },
    });
    await journal.transition(runtimeIdentity.cutoverId, {
      phase: "candidate-health",
    });
    await journal.complete(runtimeIdentity.cutoverId, {
      outcome: "committed",
      phase: "committed",
    });

    const records = await journal.read(runtimeIdentity.cutoverId);
    expect(records.map((entry) => entry.record.sequence)).toEqual([1, 2, 3, 4]);
    expect(records.map((entry) => entry.record.event)).toEqual([
      "started",
      "transition",
      "transition",
      "completed",
    ]);
    expect(records[0]!.record.previousRecordSha256).toBeNull();
    expect(records[1]!.record.previousRecordSha256).toBe(
      records[0]!.recordSha256,
    );
    expect(records[3]!.record).toMatchObject({
      outcome: "committed",
      failureReason: null,
    });
    await expect(
      journal.transition(runtimeIdentity.cutoverId, { phase: "too-late" }),
    ).rejects.toThrow(/already completed/u);
    await expect(
      journal.complete(runtimeIdentity.cutoverId, { outcome: "failed" }),
    ).rejects.toThrow(/already completed/u);
    await expect(journal.listInterrupted()).resolves.toEqual([]);
  });

  it("classifies runtime interruption before and after traffic switch", async () => {
    const early = await fixture();
    await early.journal.begin(runtimeIdentity);
    await early.journal.transition(runtimeIdentity.cutoverId, {
      phase: "candidate-health",
    });
    await expect(early.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({
        lastPhase: "candidate-health",
        recoveryAction: "stop-candidate",
      }),
    ]);

    const quiesced = await fixture();
    await quiesced.journal.begin(runtimeIdentity);
    await quiesced.journal.transition(runtimeIdentity.cutoverId, {
      phase: "checkpoint-active",
    });
    await expect(quiesced.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({
        recoveryAction: "resume-active-and-stop-candidate",
      }),
    ]);

    const switched = await fixture();
    await switched.journal.begin(runtimeIdentity);
    await switched.journal.transition(runtimeIdentity.cutoverId, {
      phase: "candidate-canary",
    });
    await expect(switched.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({
        recoveryAction: "restore-previous-traffic",
      }),
    ]);

    const committed = await fixture();
    await committed.journal.begin(runtimeIdentity);
    await committed.journal.transition(runtimeIdentity.cutoverId, {
      phase: "commit-candidate",
    });
    await expect(committed.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({ recoveryAction: "verify-runtime-commit" }),
    ]);
  });

  it("classifies renderer interruption around activation and observation", async () => {
    const preflight = await fixture();
    await preflight.journal.begin(rendererIdentity);
    await preflight.journal.transition(rendererIdentity.cutoverId, {
      phase: "preflight-candidate",
    });
    await expect(preflight.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({ recoveryAction: "discard-candidate" }),
    ]);

    const activated = await fixture();
    await activated.journal.begin(rendererIdentity);
    await activated.journal.transition(rendererIdentity.cutoverId, {
      phase: "reload-candidate",
    });
    await expect(activated.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({ recoveryAction: "restore-previous-renderer" }),
    ]);

    const observed = await fixture();
    await observed.journal.begin(rendererIdentity);
    await observed.journal.transition(rendererIdentity.cutoverId, {
      phase: "observe-candidate",
    });
    await expect(observed.journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({ recoveryAction: "verify-renderer-commit" }),
    ]);
  });

  it("records recovery intent before an adapter mutates recovery state", async () => {
    const { journal } = await fixture();
    await journal.begin(runtimeIdentity);
    await journal.transition(runtimeIdentity.cutoverId, {
      phase: "switch-traffic",
    });
    await journal.recordRecovery(
      runtimeIdentity.cutoverId,
      "restore-previous-traffic",
      { selectedInstanceId: "active-1" },
    );

    const records = await journal.read(runtimeIdentity.cutoverId);
    expect(records.at(-1)?.record).toMatchObject({
      event: "recovery",
      phase: "restore-previous-traffic",
      details: { selectedInstanceId: "active-1" },
    });
    await expect(journal.listInterrupted()).resolves.toEqual([
      expect.objectContaining({
        lastPhase: "restore-previous-traffic",
        recoveryAction: "stop-candidate",
      }),
    ]);
  });

  it("detects record tampering, missing sequence, identity drift, and records after completion", async () => {
    const first = await fixture();
    await first.journal.begin(runtimeIdentity);
    await first.journal.transition(runtimeIdentity.cutoverId, {
      phase: "start-candidate",
    });
    const records = await first.journal.read(runtimeIdentity.cutoverId);
    const secondPath = records[1]!.path;
    const second = JSON.parse(await readFile(secondPath, "utf8")) as Record<
      string,
      unknown
    >;
    second.phase = "switch-traffic";
    await writeFile(secondPath, `${JSON.stringify(second)}\n`, "utf8");
    await expect(first.journal.read(runtimeIdentity.cutoverId)).rejects.toThrow(
      /hash chain|previous-record/u,
    );

    const missing = await fixture();
    await missing.journal.begin(runtimeIdentity);
    await missing.journal.transition(runtimeIdentity.cutoverId, {
      phase: "start-candidate",
    });
    const missingRecords = await missing.journal.read(
      runtimeIdentity.cutoverId,
    );
    await rm(missingRecords[0]!.path);
    await expect(
      missing.journal.read(runtimeIdentity.cutoverId),
    ).rejects.toThrow(/missing|reordered|started/u);

    const drift = await fixture();
    await drift.journal.begin(runtimeIdentity);
    await drift.journal.transition(runtimeIdentity.cutoverId, {
      phase: "start-candidate",
    });
    const driftRecords = await drift.journal.read(runtimeIdentity.cutoverId);
    const driftRecord = JSON.parse(
      await readFile(driftRecords[1]!.path, "utf8"),
    ) as Record<string, unknown>;
    driftRecord.candidateReleaseId = "release-3";
    driftRecord.previousRecordSha256 = driftRecords[0]!.recordSha256;
    await writeFile(
      driftRecords[1]!.path,
      `${JSON.stringify(driftRecord)}\n`,
      "utf8",
    );
    await expect(drift.journal.read(runtimeIdentity.cutoverId)).rejects.toThrow(
      /identity|hash chain/u,
    );
  });

  it("serializes two journal instances and refuses a competing start", async () => {
    const { root } = await fixture();
    const left = new LayeredCutoverJournal({ rootDirectory: root });
    const right = new LayeredCutoverJournal({ rootDirectory: root });
    const results = await Promise.allSettled([
      left.begin(runtimeIdentity),
      right.begin(runtimeIdentity),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(left.read(runtimeIdentity.cutoverId)).resolves.toHaveLength(1);
  });

  it("bounds details and rejects invalid journal identity", async () => {
    const { journal } = await fixture();
    await expect(
      journal.begin({ ...runtimeIdentity, cutoverId: "../escape" }, null),
    ).rejects.toThrow(/invalid/u);
    await journal.begin(runtimeIdentity);
    await expect(
      journal.transition(runtimeIdentity.cutoverId, {
        phase: "candidate-health",
        details: { payload: "x".repeat(20_000) },
      }),
    ).rejects.toThrow(/byte limit/u);
    await expect(
      journal.complete(runtimeIdentity.cutoverId, {
        outcome: "committed",
        failureReason: "not allowed",
      }),
    ).rejects.toThrow(/Committed/u);
  });
});
