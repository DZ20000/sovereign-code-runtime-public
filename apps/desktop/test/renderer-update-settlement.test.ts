import { describe, expect, it, vi } from "vitest";

import {
  RendererUpdateSettlementPoller,
  type SettlementTimerScheduler,
} from "../src/renderer/renderer-update-settlement.js";

class FakeScheduler implements SettlementTimerScheduler {
  readonly callbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];
  nextHandle = 1;

  schedule(callback: () => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: unknown): void {
    const numeric = handle as number;
    this.cancelled.push(numeric);
    this.callbacks.delete(numeric);
  }

  fire(handle: number): void {
    const callback = this.callbacks.get(handle);
    if (callback === undefined) throw new Error(`Unknown timer ${handle}`);
    this.callbacks.delete(handle);
    callback();
  }
}

describe("RendererUpdateSettlementPoller", () => {
  it("schedules one bounded refresh while activation is pending", () => {
    const scheduler = new FakeScheduler();
    const poll = vi.fn();
    const poller = new RendererUpdateSettlementPoller(poll, {
      intervalMs: 10,
      maxAttempts: 2,
      scheduler,
    });

    poller.reconcile(true);
    poller.reconcile(true);
    expect([...scheduler.callbacks.keys()]).toEqual([1]);
    scheduler.fire(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poller.attempts).toBe(1);

    poller.reconcile(true);
    scheduler.fire(2);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poller.attempts).toBe(2);
    poller.reconcile(true);
    expect(scheduler.callbacks.size).toBe(0);
  });

  it("cancels a pending timer and resets the budget after settlement", () => {
    const scheduler = new FakeScheduler();
    const poller = new RendererUpdateSettlementPoller(() => undefined, {
      scheduler,
    });

    poller.reconcile(true);
    expect(scheduler.callbacks.has(1)).toBe(true);
    poller.reconcile(false);
    expect(scheduler.cancelled).toEqual([1]);
    expect(poller.attempts).toBe(0);

    poller.reconcile(true);
    expect([...scheduler.callbacks.keys()]).toEqual([2]);
  });

  it("disposes without allowing a later refresh", () => {
    const scheduler = new FakeScheduler();
    const poll = vi.fn();
    const poller = new RendererUpdateSettlementPoller(poll, { scheduler });

    poller.reconcile(true);
    poller.dispose();
    expect(scheduler.cancelled).toEqual([1]);
    poller.reconcile(true);
    expect(scheduler.callbacks.size).toBe(0);
    expect(poll).not.toHaveBeenCalled();
  });

  it("rejects invalid polling limits", () => {
    expect(
      () =>
        new RendererUpdateSettlementPoller(() => undefined, { maxAttempts: 0 }),
    ).toThrow(/positive integer/u);
    expect(
      () =>
        new RendererUpdateSettlementPoller(() => undefined, { intervalMs: -1 }),
    ).toThrow(/non-negative/u);
  });
});
