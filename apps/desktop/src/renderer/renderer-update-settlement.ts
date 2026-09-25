export interface SettlementTimerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface RendererUpdateSettlementPollerOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly scheduler?: SettlementTimerScheduler;
}

const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_MAX_ATTEMPTS = 20;

const defaultScheduler: SettlementTimerScheduler = {
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: (handle) => window.clearTimeout(handle as number),
};

export class RendererUpdateSettlementPoller {
  readonly #poll: () => void | Promise<void>;
  readonly #scheduler: SettlementTimerScheduler;
  readonly #intervalMs: number;
  readonly #maxAttempts: number;
  #handle: unknown | null = null;
  #attempts = 0;
  #disposed = false;

  constructor(
    poll: () => void | Promise<void>,
    options: RendererUpdateSettlementPollerOptions = {},
  ) {
    this.#poll = poll;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs < 0) {
      throw new Error(
        "Renderer settlement polling interval must be non-negative.",
      );
    }
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new Error(
        "Renderer settlement polling attempts must be a positive integer.",
      );
    }
  }

  reconcile(pending: boolean): void {
    if (this.#disposed) return;
    if (!pending) {
      this.#reset();
      return;
    }
    if (this.#handle !== null || this.#attempts >= this.#maxAttempts) return;
    this.#handle = this.#scheduler.schedule(() => {
      this.#handle = null;
      if (this.#disposed) return;
      this.#attempts += 1;
      void this.#poll();
    }, this.#intervalMs);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelScheduled();
  }

  get attempts(): number {
    return this.#attempts;
  }

  #reset(): void {
    this.#cancelScheduled();
    this.#attempts = 0;
  }

  #cancelScheduled(): void {
    if (this.#handle === null) return;
    this.#scheduler.cancel(this.#handle);
    this.#handle = null;
  }
}
