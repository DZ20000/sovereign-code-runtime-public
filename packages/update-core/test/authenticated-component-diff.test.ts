import { describe, expect, it } from "vitest";
import {
  buildVerifiedLayeredUpdateCandidate,
  diffAuthenticatedComponentInventories,
  type AuthenticatedComponentInventory,
} from "../src/authenticated-component-diff.js";
import { LayeredUpdateCoordinator } from "../src/layered-update.js";

function inventory(
  manifestSha256: string,
  components: AuthenticatedComponentInventory["components"],
): AuthenticatedComponentInventory {
  return { manifestSha256, components };
}

const before = inventory("a".repeat(64), [
  {
    path: "renderer/index.html",
    role: "renderer",
    sha256: "1".repeat(64),
    bytes: 100,
  },
  {
    path: "runtime/runtime-host.cjs",
    role: "runtime-host",
    sha256: "2".repeat(64),
    bytes: 200,
  },
]);

describe("authenticated component inventory diff", () => {
  it("derives added, modified, and removed changes in portable path order", () => {
    const after = inventory("b".repeat(64), [
      {
        path: "renderer/index.html",
        role: "renderer",
        sha256: "3".repeat(64),
        bytes: 101,
      },
      {
        path: "renderer/assets/main.js",
        role: "renderer",
        sha256: "4".repeat(64),
        bytes: 300,
      },
    ]);

    expect(diffAuthenticatedComponentInventories(before, after)).toEqual([
      {
        path: "renderer/assets/main.js",
        role: "renderer",
        change: "added",
      },
      { path: "renderer/index.html", role: "renderer", change: "modified" },
      {
        path: "runtime/runtime-host.cjs",
        role: "runtime-host",
        change: "removed",
      },
    ]);
  });

  it("represents a signed role change as removal plus addition", () => {
    const after = inventory("b".repeat(64), [
      {
        path: "renderer/index.html",
        role: "desktop-shell",
        sha256: "1".repeat(64),
        bytes: 100,
      },
      before.components[1]!,
    ]);

    expect(diffAuthenticatedComponentInventories(before, after)).toEqual([
      {
        path: "renderer/index.html",
        role: "renderer",
        change: "removed",
      },
      {
        path: "renderer/index.html",
        role: "desktop-shell",
        change: "added",
      },
    ]);
  });

  it("does not accept case-only path changes or portable collisions", () => {
    expect(() =>
      diffAuthenticatedComponentInventories(
        inventory("a".repeat(64), [before.components[0]!]),
        inventory("b".repeat(64), [
          { ...before.components[0]!, path: "Renderer/index.html" },
        ]),
      ),
    ).toThrow(/case of component path/u);

    expect(() =>
      diffAuthenticatedComponentInventories(
        inventory("a".repeat(64), []),
        inventory("b".repeat(64), [
          before.components[0]!,
          { ...before.components[0]!, path: "Renderer/index.html" },
        ]),
      ),
    ).toThrow(/duplicate portable path/u);
  });

  it("rejects traversal, alternate separators, malformed roles, and digests", () => {
    for (const component of [
      { ...before.components[0]!, path: "../index.html" },
      { ...before.components[0]!, path: "renderer\\index.html" },
      { ...before.components[0]!, role: "Renderer Shell" },
      { ...before.components[0]!, sha256: "not-a-digest" },
    ]) {
      expect(() =>
        diffAuthenticatedComponentInventories(
          inventory("a".repeat(64), []),
          inventory("b".repeat(64), [component]),
        ),
      ).toThrow();
    }
  });

  it("builds the coordinator candidate from authenticated inventories", async () => {
    const after = inventory("b".repeat(64), [
      {
        ...before.components[0]!,
        sha256: "5".repeat(64),
      },
      before.components[1]!,
    ]);
    const candidate = buildVerifiedLayeredUpdateCandidate({
      releaseId: "release-2",
      releaseSequence: 2,
      signingKeyId: "key-1",
      verifiedAt: 100,
      previous: before,
      candidate: after,
      renderer: { candidateReleaseId: "renderer-2", expectedGeneration: 1 },
    });

    expect(candidate).toMatchObject({
      releaseId: "release-2",
      manifestSha256: "b".repeat(64),
      changes: [
        {
          path: "renderer/index.html",
          role: "renderer",
          change: "modified",
        },
      ],
    });

    const receipt = await new LayeredUpdateCoordinator({
      now: () => 100,
      adapter: {
        renderer: {
          cutover: async (input) => ({
            cutoverId: input.cutoverId,
            outcome: "committed",
            previousReleaseId: "renderer-1",
            candidateReleaseId: input.candidateReleaseId,
            previousGeneration: 1,
            finalGeneration: 2,
            stateBytes: 0,
            startedAt: 100,
            completedAt: 101,
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
    }).execute(candidate);

    expect(receipt).toMatchObject({
      strategy: "renderer-reload",
      outcome: "committed",
    });
  });

  it("forces a role downgrade attempt onto the restart path", async () => {
    const after = inventory("b".repeat(64), [
      {
        ...before.components[0]!,
        role: "desktop-shell",
      },
      before.components[1]!,
    ]);
    const candidate = buildVerifiedLayeredUpdateCandidate({
      releaseId: "release-role-change",
      releaseSequence: 3,
      signingKeyId: "key-1",
      verifiedAt: 100,
      previous: before,
      candidate: after,
    });

    const receipt = await new LayeredUpdateCoordinator({
      now: () => 100,
      adapter: {
        executeRestart: async (request) => {
          expect(request.plan.mode).toBe("application-restart");
          return {
            outcome: "restart-required",
            failureReason: null,
            receiptId: "restart-role-change",
          };
        },
      },
    }).execute(candidate);

    expect(receipt).toMatchObject({
      strategy: "application-restart",
      outcome: "restart-required",
    });
  });
});
