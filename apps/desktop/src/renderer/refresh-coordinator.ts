export type RefreshMode = "poll" | "full";

export function computeRefreshDelayMs(
  baseDelayMs: number,
  consecutiveFailures: number,
  maximumDelayMs = 30_000,
): number {
  const safeBase = Math.max(250, Math.floor(baseDelayMs));
  const safeFailures = Math.max(0, Math.min(8, Math.floor(consecutiveFailures)));
  return Math.min(maximumDelayMs, safeBase * (2 ** safeFailures));
}

const refreshPriority: Readonly<Record<RefreshMode, number>> = {
  poll: 0,
  full: 1,
};

function mergeRefreshMode(
  current: RefreshMode | null,
  requested: RefreshMode,
): RefreshMode {
  if (current === null) {
    return requested;
  }
  return refreshPriority[requested] > refreshPriority[current] ? requested : current;
}

/**
 * Serializes renderer refreshes and collapses bursts into at most one trailing pass.
 * A pending poll is upgraded to a full refresh instead of executing both.
 */
export class RefreshCoordinator {
  private inFlight: Promise<void> | null = null;
  private requestedMode: RefreshMode | null = null;

  public constructor(
    private readonly execute: (mode: RefreshMode) => Promise<void>,
  ) {}

  public request(mode: RefreshMode): Promise<void> {
    this.requestedMode = mergeRefreshMode(this.requestedMode, mode);
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    while (this.requestedMode !== null) {
      const mode = this.requestedMode;
      this.requestedMode = null;
      await this.execute(mode);
    }
  }
}
