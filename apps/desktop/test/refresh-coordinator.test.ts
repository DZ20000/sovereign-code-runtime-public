import { describe, expect, it } from "vitest";

import {
  computeRefreshDelayMs,
  RefreshCoordinator,
  type RefreshMode,
} from "../src/renderer/refresh-coordinator.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("RefreshCoordinator", () => {
  it("serializes refreshes and collapses a poll burst", async () => {
    const firstPass = deferred();
    const calls: RefreshMode[] = [];
    const coordinator = new RefreshCoordinator(async (mode) => {
      calls.push(mode);
      if (calls.length === 1) {
        await firstPass.promise;
      }
    });

    const first = coordinator.request("poll");
    await Promise.resolve();
    const second = coordinator.request("poll");
    const third = coordinator.request("poll");
    expect(second).toBe(first);
    expect(third).toBe(first);
    firstPass.resolve();
    await first;

    expect(calls).toEqual(["poll", "poll"]);
  });

  it("upgrades the trailing pass to a full refresh", async () => {
    const firstPass = deferred();
    const calls: RefreshMode[] = [];
    const coordinator = new RefreshCoordinator(async (mode) => {
      calls.push(mode);
      if (calls.length === 1) {
        await firstPass.promise;
      }
    });

    const pending = coordinator.request("poll");
    await Promise.resolve();
    coordinator.request("poll");
    coordinator.request("full");
    firstPass.resolve();
    await pending;

    expect(calls).toEqual(["poll", "full"]);
  });

  it("starts a new cycle after completion", async () => {
    const calls: RefreshMode[] = [];
    const coordinator = new RefreshCoordinator(async (mode) => {
      calls.push(mode);
    });

    await coordinator.request("poll");
    await coordinator.request("full");

    expect(calls).toEqual(["poll", "full"]);
  });
});

describe("computeRefreshDelayMs", () => {
  it("backs off exponentially and caps the delay", () => {
    expect(computeRefreshDelayMs(1_000, 0)).toBe(1_000);
    expect(computeRefreshDelayMs(1_000, 3)).toBe(8_000);
    expect(computeRefreshDelayMs(5_000, 8)).toBe(30_000);
  });

  it("normalizes invalid low inputs", () => {
    expect(computeRefreshDelayMs(0, -4)).toBe(250);
    expect(computeRefreshDelayMs(499.9, 1)).toBe(998);
  });
});
