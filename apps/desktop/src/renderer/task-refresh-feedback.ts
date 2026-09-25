interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface RefreshButton extends AttributeTarget {
  disabled: boolean;
}

interface RefreshStatus {
  textContent: string | null;
}

export interface TaskRefreshSnapshot {
  readonly revision: number;
  readonly totalTaskCount: number;
}

export interface TaskRefreshFeedbackOptions {
  readonly button: RefreshButton;
  readonly busyRegion: AttributeTarget;
  readonly status: RefreshStatus;
  readonly syncStatus: RefreshStatus;
}

export function taskRefreshSuccessMessage(
  previousRevision: number | null,
  snapshot: TaskRefreshSnapshot,
): string {
  if (previousRevision === snapshot.revision) {
    return "Task board refreshed. No changes.";
  }
  const noun = snapshot.totalTaskCount === 1 ? "record" : "records";
  return `Task board refreshed. ${snapshot.totalTaskCount} ${noun} loaded.`;
}

export function taskRefreshUnavailableMessage(hasSnapshot: boolean): string {
  return hasSnapshot
    ? "Task board unavailable. Showing the last successful snapshot."
    : "Task board unavailable. No successful snapshot is available.";
}

export class TaskRefreshFeedback {
  readonly #button: RefreshButton;
  readonly #busyRegion: AttributeTarget;
  readonly #status: RefreshStatus;
  readonly #syncStatus: RefreshStatus;
  #statusSource: string | null = null;
  #syncStatusSource: string | null = null;
  #syncFailure: string | null = null;

  constructor(options: TaskRefreshFeedbackOptions) {
    this.#button = options.button;
    this.#busyRegion = options.busyRegion;
    this.#status = options.status;
    this.#syncStatus = options.syncStatus;
  }

  begin(): void {
    this.#button.disabled = true;
    this.#button.setAttribute("aria-busy", "true");
    this.#busyRegion.setAttribute("aria-busy", "true");
    this.#setStatus("Refreshing task board…");
  }

  succeed(
    previousRevision: number | null,
    snapshot: TaskRefreshSnapshot,
  ): void {
    this.markAvailable();
    this.#setStatus(taskRefreshSuccessMessage(previousRevision, snapshot));
  }

  manualFail(hasSnapshot: boolean): void {
    this.#setStatus(
      "Task board refresh failed. Existing task data was not replaced.",
    );
    this.backgroundFail(hasSnapshot);
  }

  backgroundFail(hasSnapshot: boolean): void {
    this.#syncFailure = taskRefreshUnavailableMessage(hasSnapshot);
    this.#setSyncStatus(this.#syncFailure);
  }

  markAvailable(): void {
    this.#syncFailure = null;
  }

  sync(value: string): void {
    this.#setSyncStatus(this.#syncFailure ?? value);
  }

  #setStatus(value: string): void {
    if (this.#statusSource === value) return;
    this.#statusSource = value;
    this.#status.textContent = value;
  }

  #setSyncStatus(value: string): void {
    if (this.#syncStatusSource === value) return;
    this.#syncStatusSource = value;
    this.#syncStatus.textContent = value;
  }

  end(): void {
    this.#button.disabled = false;
    this.#button.removeAttribute("aria-busy");
    this.#busyRegion.removeAttribute("aria-busy");
  }
}
