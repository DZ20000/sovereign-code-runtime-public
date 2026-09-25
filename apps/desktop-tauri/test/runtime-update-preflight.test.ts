import { describe, expect, it } from "vitest";

import {
  assessRuntimeUpdateReadiness,
  parseRuntimeManagedUpdatePreflightArguments,
} from "../scripts/runtime-update-preflight.mjs";
import type { AuditManagedRuntimeCandidateStateResult } from "../scripts/audit-runtime-candidate-state.mjs";
import type { AuditManagedRuntimeHostReleaseIndexResult } from "../scripts/stage-runtime-host-release-index.mjs";

function releaseIndex(
  releaseIds: readonly string[],
): AuditManagedRuntimeHostReleaseIndexResult {
  return {
    schemaVersion: "scr.runtime-host-release-index-managed-audit/v1",
    consistent: true,
    receiptCount: 1,
    latestIndexSequence: 1,
    highestReleaseSequence: releaseIds.length,
    releaseIds,
  };
}

function candidate(
  options: {
    readonly inbox?: readonly string[];
    readonly installed?: readonly string[];
    readonly active?: string | null;
  } = {},
): AuditManagedRuntimeCandidateStateResult {
  return {
    schemaVersion: "scr.runtime-candidate-managed-audit/v1",
    consistent: true,
    highestReleaseSequence: options.installed?.length ?? 0,
    activeReleaseId: options.active ?? null,
    installedReleaseIds: options.installed ?? [],
    inboxReleaseIds: options.inbox ?? [],
    stateBackupPresent: false,
  };
}

describe("Runtime managed update readiness", () => {
  it("allows a read-only audit without selecting a release", () => {
    expect(
      assessRuntimeUpdateReadiness({
        operation: "audit",
        releaseId: null,
        releaseIndex: releaseIndex([]),
        candidate: candidate(),
      }),
    ).toEqual({ operation: "audit", releaseId: null, ready: true });
  });

  it("allows installation only for a verified inbox release that is not installed", () => {
    expect(
      assessRuntimeUpdateReadiness({
        operation: "install",
        releaseId: "runtime-2",
        releaseIndex: releaseIndex(["runtime-2"]),
        candidate: candidate({ inbox: ["runtime-2"] }),
      }),
    ).toEqual({ operation: "install", releaseId: "runtime-2", ready: true });

    expect(() =>
      assessRuntimeUpdateReadiness({
        operation: "install",
        releaseId: "runtime-2",
        releaseIndex: releaseIndex(["runtime-2"]),
        candidate: candidate({
          inbox: ["runtime-2"],
          installed: ["runtime-2"],
        }),
      }),
    ).toThrow("already installed");
  });

  it("allows activation only for a verified installed release that is not active", () => {
    expect(
      assessRuntimeUpdateReadiness({
        operation: "activate",
        releaseId: "runtime-2",
        releaseIndex: releaseIndex(["runtime-2"]),
        candidate: candidate({
          inbox: ["runtime-2"],
          installed: ["runtime-2"],
          active: "runtime-1",
        }),
      }),
    ).toEqual({ operation: "activate", releaseId: "runtime-2", ready: true });

    expect(() =>
      assessRuntimeUpdateReadiness({
        operation: "activate",
        releaseId: "runtime-2",
        releaseIndex: releaseIndex(["runtime-2"]),
        candidate: candidate({
          inbox: ["runtime-2"],
          installed: ["runtime-2"],
          active: "runtime-2",
        }),
      }),
    ).toThrow("already active");
  });

  it("rejects releases missing from either verified inventory", () => {
    expect(() =>
      assessRuntimeUpdateReadiness({
        operation: "install",
        releaseId: "runtime-2",
        releaseIndex: releaseIndex([]),
        candidate: candidate({ inbox: ["runtime-2"] }),
      }),
    ).toThrow("release-index inbox");

    expect(() =>
      assessRuntimeUpdateReadiness({
        operation: "activate",
        releaseId: "runtime-2",
        releaseIndex: releaseIndex(["runtime-2"]),
        candidate: candidate({ installed: ["runtime-2"] }),
      }),
    ).toThrow("candidate inbox");
  });

  it("rejects invalid operation and release identity combinations", () => {
    expect(() =>
      assessRuntimeUpdateReadiness({
        operation: "audit",
        releaseId: "runtime-1",
        releaseIndex: releaseIndex(["runtime-1"]),
        candidate: candidate({ inbox: ["runtime-1"] }),
      }),
    ).toThrow("may not select a release ID");

    expect(() =>
      assessRuntimeUpdateReadiness({
        operation: "install",
        releaseId: "runtime:invalid",
        releaseIndex: releaseIndex([]),
        candidate: candidate(),
      }),
    ).toThrow("valid release ID");
  });
  it("parses target-bound CLI operations and rejects incomplete combinations", () => {
    const common = [
      "--managed-root",
      "managed",
      "--runtime-trust",
      "runtime-trust.json",
      "--shell-version",
      "1.0.0",
      "--runtime-protocol-version",
      "1",
    ];
    expect(
      parseRuntimeManagedUpdatePreflightArguments([
        ...common,
        "--operation",
        "install",
        "--release-id",
        "runtime-2",
      ]),
    ).toMatchObject({
      operation: "install",
      releaseId: "runtime-2",
      runtimeProtocolVersion: 1,
    });
    expect(parseRuntimeManagedUpdatePreflightArguments(common)).toMatchObject({
      operation: "audit",
      releaseId: null,
    });
    expect(() =>
      parseRuntimeManagedUpdatePreflightArguments([
        ...common,
        "--operation",
        "activate",
      ]),
    ).toThrow("requires a valid release ID");
    expect(() =>
      parseRuntimeManagedUpdatePreflightArguments([
        ...common,
        "--release-id",
        "runtime-2",
      ]),
    ).toThrow("may not select a release ID");
  });
});
