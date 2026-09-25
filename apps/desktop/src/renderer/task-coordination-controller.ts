import type {
  SovereignDesktopApi,
  TaskCoordinationOperatorInbox,
} from "../shared.js";
import {
  loadTaskCoordinationInbox,
  mergeTaskCoordinationLatestPage,
  mergeTaskCoordinationOlderPage,
  renderTaskCoordinationHistoryControls,
  renderTaskCoordinationInbox,
  renderTaskCoordinationLoading,
  renderTaskCoordinationPendingCount,
  renderTaskCoordinationSnapshotFreshness,
  renderTaskCoordinationSnapshotStatus,
  renderTaskCoordinationUnavailable,
  type TaskCoordinationHistoryStatus,
  type TaskCoordinationInboxElements,
  type TaskCoordinationScrollMode,
} from "./task-coordination-inbox.js";

interface ApplySnapshotOptions {
  readonly scrollMode?: TaskCoordinationScrollMode;
  readonly latestUpdatedAt?: string;
}

export class TaskCoordinationInboxController {
  #taskId: string | null = null;
  #generation = 0;
  #refreshRequest: Promise<void> | null = null;
  #olderRequest: Promise<void> | null = null;
  #snapshot: TaskCoordinationOperatorInbox | null = null;
  #count: number | null = null;
  #failed = false;
  #snapshotStale = false;
  #lastUpdatedAt: string | null = null;
  #historyStatus: TaskCoordinationHistoryStatus = "idle";
  #signature = "";

  constructor(
    readonly api: Pick<SovereignDesktopApi, "getTaskCoordinationInbox">,
    readonly elements: TaskCoordinationInboxElements,
    readonly timestampLabel: (value: string) => string,
    readonly refreshButton: HTMLButtonElement,
  ) {
    refreshButton.addEventListener("click", () => {
      if (this.#taskId !== null) void this.refresh(this.#taskId);
    });
    elements.loadOlderButton.addEventListener("click", () => {
      if (this.#taskId !== null) void this.loadOlder(this.#taskId);
    });
  }

  clear(): void {
    this.#generation += 1;
    this.#taskId = null;
    this.#refreshRequest = null;
    this.#olderRequest = null;
    this.#snapshot = null;
    this.#count = null;
    this.#signature = "";
    this.#failed = false;
    this.#snapshotStale = false;
    this.#lastUpdatedAt = null;
    this.#historyStatus = "idle";
    this.elements.container.removeAttribute("data-task-id");
    this.elements.container.setAttribute("aria-busy", "false");
    this.refreshButton.disabled = true;
    renderTaskCoordinationSnapshotStatus(this.elements, "idle");
    renderTaskCoordinationHistoryControls(this.elements, null, "idle");
  }

  select(taskId: string): void {
    if (this.#taskId === taskId) return;
    this.clear();
    this.#taskId = taskId;
    this.refreshButton.disabled = false;
    renderTaskCoordinationLoading(this.elements, null);
  }

  updatePendingCount(taskId: string, count: number): void {
    // Task detail and coordination reads are independent. A late detail response
    // must not overwrite counters from the authoritative coordination snapshot.
    if (taskId !== this.#taskId || this.#snapshot !== null) return;
    this.#count = count;
    renderTaskCoordinationPendingCount(this.elements.pendingCount, count);
  }

  rerender(): void {
    if (this.#taskId === null) return;
    if (this.#snapshot !== null) {
      renderTaskCoordinationInbox(
        this.elements,
        this.#snapshot,
        this.timestampLabel,
        {
          stale: this.#snapshotStale,
          lastUpdatedAt:
            this.#lastUpdatedAt ?? this.#snapshot.generatedAt,
        },
      );
    } else if (this.#failed) {
      renderTaskCoordinationUnavailable(this.elements, this.#count);
    } else {
      renderTaskCoordinationLoading(this.elements, this.#count);
    }
    this.#syncControls();
  }

  #syncControls(): void {
    this.refreshButton.disabled =
      this.#taskId === null || this.#refreshRequest !== null;
    renderTaskCoordinationHistoryControls(
      this.elements,
      this.#snapshot?.nextBeforeSequence ?? null,
      this.#historyStatus,
      this.#refreshRequest !== null || this.#olderRequest !== null,
    );
  }

  #applySnapshot(
    snapshot: TaskCoordinationOperatorInbox,
    options: ApplySnapshotOptions = {},
  ): void {
    this.#snapshot = snapshot;
    this.#count = snapshot.pendingCount;
    if (options.latestUpdatedAt !== undefined) {
      this.#lastUpdatedAt = options.latestUpdatedAt;
      this.#snapshotStale = false;
    }
    const lastUpdatedAt = this.#lastUpdatedAt ?? snapshot.generatedAt;
    const signature = JSON.stringify({ ...snapshot, generatedAt: null });
    if (signature !== this.#signature) {
      renderTaskCoordinationInbox(
        this.elements,
        snapshot,
        this.timestampLabel,
        {
          ...(options.scrollMode === undefined
            ? {}
            : { scrollMode: options.scrollMode }),
          stale: this.#snapshotStale,
          lastUpdatedAt,
        },
      );
      this.#signature = signature;
    } else {
      renderTaskCoordinationSnapshotFreshness(
        this.elements,
        snapshot,
        lastUpdatedAt,
        this.#snapshotStale,
        this.timestampLabel,
      );
    }
    this.#syncControls();
  }

  #markSnapshotStale(): void {
    const snapshot = this.#snapshot;
    if (snapshot === null || this.#snapshotStale) return;
    this.#snapshotStale = true;
    renderTaskCoordinationSnapshotFreshness(
      this.elements,
      snapshot,
      this.#lastUpdatedAt ?? snapshot.generatedAt,
      true,
      this.timestampLabel,
    );
  }

  refresh(taskId: string): Promise<void> {
    if (this.#taskId !== taskId) return Promise.resolve();
    if (this.#refreshRequest !== null) return this.#refreshRequest;

    // A latest-page refresh supersedes any in-flight history request. The API is
    // not abortable, so the request generation discards its eventual response.
    const generation = ++this.#generation;
    this.#olderRequest = null;
    this.#historyStatus = "idle";
    this.elements.container.setAttribute("aria-busy", "true");
    const request = loadTaskCoordinationInbox(this.api, taskId)
      .then((result) => {
        if (generation !== this.#generation || taskId !== this.#taskId) return;
        if (result.inbox === null) {
          if (this.#snapshot === null) {
            this.#failed = true;
            this.#signature = "";
            renderTaskCoordinationUnavailable(this.elements, this.#count);
          } else {
            this.#failed = false;
            this.#markSnapshotStale();
          }
          return;
        }
        if (
          this.#lastUpdatedAt !== null &&
          Date.parse(result.inbox.generatedAt) <
            Date.parse(this.#lastUpdatedAt)
        ) {
          return;
        }
        try {
          const merged = mergeTaskCoordinationLatestPage(
            this.#snapshot,
            result.inbox,
          );
          this.#failed = false;
          this.#historyStatus = "idle";
          this.#applySnapshot(merged, {
            latestUpdatedAt: result.inbox.generatedAt,
          });
        } catch {
          if (this.#snapshot === null) {
            this.#failed = true;
            this.#signature = "";
            renderTaskCoordinationUnavailable(this.elements, this.#count);
          } else {
            this.#markSnapshotStale();
          }
        }
      })
      .finally(() => {
        if (
          generation !== this.#generation ||
          this.#refreshRequest !== request
        ) {
          return;
        }
        this.#refreshRequest = null;
        this.elements.container.setAttribute("aria-busy", "false");
        this.#syncControls();
      });
    this.#refreshRequest = request;
    this.#syncControls();
    return request;
  }

  loadOlder(taskId: string): Promise<void> {
    if (taskId !== this.#taskId || this.#snapshot === null) {
      return Promise.resolve();
    }
    if (this.#refreshRequest !== null) return this.#refreshRequest;
    if (this.#olderRequest !== null) return this.#olderRequest;
    const beforeSequence = this.#snapshot.nextBeforeSequence;
    if (beforeSequence === null) return Promise.resolve();

    const generation = this.#generation;
    this.#historyStatus = "loading";
    const request = loadTaskCoordinationInbox(
      this.api,
      taskId,
      beforeSequence,
    )
      .then((result) => {
        if (generation !== this.#generation || taskId !== this.#taskId) return;
        if (result.inbox === null || this.#snapshot === null) {
          this.#historyStatus = "error";
          return;
        }
        try {
          const merged = mergeTaskCoordinationOlderPage(
            this.#snapshot,
            result.inbox,
            beforeSequence,
          );
          this.#historyStatus = "loaded";
          this.#applySnapshot(merged, { scrollMode: "prepend" });
        } catch {
          this.#historyStatus = "error";
        }
      })
      .finally(() => {
        if (
          generation !== this.#generation ||
          this.#olderRequest !== request
        ) {
          return;
        }
        this.#olderRequest = null;
        this.#syncControls();
      });
    this.#olderRequest = request;
    this.#syncControls();
    return request;
  }
}
