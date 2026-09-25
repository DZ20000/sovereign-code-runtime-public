import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RESTART_JOURNAL_ENTRY_SCHEMA_VERSION,
  RestartJournal,
  type RestartIntentIdentity,
  type RestartJournalEntry,
} from "../src/restart-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-restart-journal-"));
  roots.push(root);
  let clock = 1_000;
  return {
    root,
    journal: new RestartJournal({
      rootDirectory: root,
      now: () => clock++,
    }),
  };
}

function identity(
  updateId = "restart-update-1",
  overrides: Partial<RestartIntentIdentity> = {},
): RestartIntentIdentity {
  return {
    updateId,
    currentReleaseId: "release-1",
    candidateReleaseId: "release-2",
    restartId: `restart-${updateId}`,
    checkpointId: `checkpoint-${updateId}`,
    checkpointSha256: "a".repeat(64),
    fencingToken: `fence-${updateId}`,
    ...overrides,
  };
}

describe("RestartJournal", () => {
  it("persists the successful restart lifecycle in a contiguous hash chain", async () => {
    const { journal } = await fixture();
    await journal.prepare(identity());
    await journal.transition("restart-update-1", "restart-requested");
    await journal.transition("restart-update-1", "candidate-started");
    await journal.transition("restart-update-1", "candidate-healthy");
    await journal.transition("restart-update-1", "committed");

    const entries = await journal.readAll();
    expect(entries.map((entry) => entry.phase)).toEqual([
      "prepared",
      "restart-requested",
      "candidate-started",
      "candidate-healthy",
      "committed",
    ]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(entries[0]?.previousEntrySha256).toBeNull();
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]?.previousEntrySha256).toBe(
        entries[index - 1]?.entrySha256,
      );
    }
    expect(entries.at(-1)?.schemaVersion).toBe(
      RESTART_JOURNAL_ENTRY_SCHEMA_VERSION,
    );
    await expect(journal.openIntent()).resolves.toBeNull();
  });

  it("supports a new restart intent only after the previous one is terminal", async () => {
    const { journal } = await fixture();
    await journal.prepare(identity("restart-update-1"));
    await journal.transition("restart-update-1", "failed", "launcher failed");
    const next = await journal.prepare(
      identity("restart-update-2", {
        currentReleaseId: "release-1",
        candidateReleaseId: "release-3",
      }),
    );

    expect(next).toMatchObject({
      sequence: 3,
      phase: "prepared",
      updateId: "restart-update-2",
      candidateReleaseId: "release-3",
    });
    await expect(journal.openIntent()).resolves.toEqual(next);
  });

  it("makes identical prepare and phase retries idempotent", async () => {
    const { journal } = await fixture();
    const first = await journal.prepare(identity());
    const second = await journal.prepare(identity());
    expect(second).toEqual(first);

    const requested = await journal.transition(
      "restart-update-1",
      "restart-requested",
    );
    const retried = await journal.transition(
      "restart-update-1",
      "restart-requested",
    );
    expect(retried).toEqual(requested);
    await expect(journal.readAll()).resolves.toHaveLength(2);
  });

  it("rejects overlapping intents, identity changes, and invalid transitions", async () => {
    const { journal } = await fixture();
    await journal.prepare(identity());
    await expect(
      journal.prepare(
        identity("restart-update-2", {
          candidateReleaseId: "release-3",
        }),
      ),
    ).rejects.toThrow(/already open/u);
    await expect(
      journal.transition("restart-update-1", "candidate-started"),
    ).rejects.toThrow(/prepared -> candidate-started/u);
    await expect(
      journal.transition("different-update", "restart-requested"),
    ).rejects.toThrow(/not open/u);
  });

  it("serializes two process-local journal instances so only one intent wins", async () => {
    const { root } = await fixture();
    const left = new RestartJournal({ rootDirectory: root });
    const right = new RestartJournal({ rootDirectory: root });
    const outcomes = await Promise.allSettled([
      left.prepare(
        identity("restart-left", { candidateReleaseId: "release-2" }),
      ),
      right.prepare(
        identity("restart-right", { candidateReleaseId: "release-3" }),
      ),
    ]);

    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === "rejected"),
    ).toHaveLength(1);
    await expect(left.readAll()).resolves.toHaveLength(1);
  });

  it("detects payload tampering, filename mismatch, and unexpected entries", async () => {
    const { root, journal } = await fixture();
    await journal.prepare(identity());
    const entriesDirectory = join(root, "entries");
    const [fileName] = await readdir(entriesDirectory);
    const path = join(entriesDirectory, fileName!);
    const entry = JSON.parse(
      await readFile(path, "utf8"),
    ) as RestartJournalEntry;
    await writeFile(
      path,
      `${JSON.stringify({ ...entry, candidateReleaseId: "release-tampered" })}\n`,
      "utf8",
    );
    await expect(journal.readAll()).rejects.toThrow(/digest does not match/u);

    await rm(path);
    await writeFile(join(entriesDirectory, "unexpected.txt"), "x", "utf8");
    await expect(journal.readAll()).rejects.toThrow(/unexpected entry/u);
  });

  it("records a bounded failure reason only on an allowed terminal transition", async () => {
    const { journal } = await fixture();
    await journal.prepare(identity());
    const failed = await journal.transition(
      "restart-update-1",
      "failed",
      "launcher failed before process exit",
    );
    expect(failed.failureReason).toBe("launcher failed before process exit");
    await expect(journal.openIntent()).resolves.toBeNull();

    const second = await fixture();
    await second.journal.prepare(identity());
    await expect(
      second.journal.transition(
        "restart-update-1",
        "failed",
        "x".repeat(1_025),
      ),
    ).rejects.toThrow(/failure reason/u);
  });

  it("rejects invalid digest and same-release identities before writing", async () => {
    const { journal } = await fixture();
    await expect(
      journal.prepare(
        identity("restart-invalid", {
          checkpointSha256: "not-a-digest",
        }),
      ),
    ).rejects.toThrow(/checkpoint digest/u);
    await expect(
      journal.prepare(
        identity("restart-same-release", {
          candidateReleaseId: "release-1",
        }),
      ),
    ).rejects.toThrow(/must differ/u);
    await expect(journal.readAll()).resolves.toEqual([]);
  });
});
