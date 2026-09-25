import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

describe("notification policy static guards", () => {
  it("keeps notification delivery semantic and direct", () => {
    const manager = source(
      "packages/windows-adapter/src/notification-manager.ts",
    );
    const completion = source(
      "packages/windows-adapter/src/run-completion-notifier.ts",
    );
    const toolkit = source("packages/toolkit/src/index.ts");
    const readme = source("README.md");

    for (const rejected of [
      "maximumNotificationsPerWindow",
      "rateWindowMs",
      "duplicateWindowMs",
      "acceptedDigests",
      "pendingReservations",
      "assertRateLimitAvailable",
      "assertNotDuplicate",
    ]) {
      expect(manager).not.toContain(rejected);
    }
    expect(manager).not.toContain("sha256(");

    for (const rejected of [
      "milestone",
      "taskIdentitySha256",
      "phaseIdentitySha256",
      "equivalenceKeySha256",
      "rateScopeKey",
      "notificationAttempts",
      "rate-limited",
      "dedupeWindowMs",
    ]) {
      expect(completion).not.toContain(rejected);
    }
    expect(completion).toContain(
      'run.state === "succeeded" && run.kind !== "workflow"',
    );
    expect(completion).toContain('reason: "routine-success"');
    expect(completion).toContain('reason: "runtime-interrupted"');

    expect(toolkit).toContain(
      "when a project or Task reaches a meaningful work node, completes, or needs operator attention",
    );
    expect(readme).toContain(
      "has no notification milestones, content-hash deduplication, or per-domain/rolling notification buckets",
    );
  });
});
