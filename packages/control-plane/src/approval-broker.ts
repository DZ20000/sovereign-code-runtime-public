import { randomUUID } from "node:crypto";

export type ApprovalDecision = "allow-once" | "deny" | "drop-to-l1";
export type ApprovalCancellationReason =
  | "timeout"
  | "cancelled"
  | "runtime-stop"
  | "tunnel-stop"
  | "workspace-change"
  | "window-closed"
  | "surface-error"
  | "queue-overflow";

export interface ApprovalRequestInput {
  readonly toolName: string;
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export interface ApprovalPresentation extends ApprovalRequestInput {
  readonly id: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly burstDetected: boolean;
}

export type ApprovalLifecycleKind =
  | "requested"
  | "queued"
  | "presented"
  | "resolved"
  | "cancelled"
  | "queue-overflow";

export interface ApprovalLifecycleEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly kind: ApprovalLifecycleKind;
  readonly queueDepth: number;
  readonly burstDetected: boolean;
  readonly decision?: ApprovalDecision;
  readonly reason?: ApprovalCancellationReason;
}

export interface ApprovalSurface {
  present(request: ApprovalPresentation, signal: AbortSignal): Promise<ApprovalDecision>;
}

interface PendingApproval {
  readonly presentation: ApprovalPresentation;
  readonly resolve: (decision: ApprovalDecision) => void;
}

interface ActiveApproval {
  readonly pending: PendingApproval;
  readonly abortController: AbortController;
  readonly cancel: (reason: ApprovalCancellationReason) => void;
}

export interface ApprovalBrokerOptions {
  readonly surface: ApprovalSurface;
  readonly timeoutMs?: number;
  readonly burstWindowMs?: number;
  readonly burstThreshold?: number;
  readonly maxQueue?: number;
  readonly maxEvents?: number;
  readonly now?: () => number;
}

export class ApprovalBroker {
  readonly #surface: ApprovalSurface;
  readonly #timeoutMs: number;
  readonly #burstWindowMs: number;
  readonly #burstThreshold: number;
  readonly #maxQueue: number;
  readonly #maxEvents: number;
  readonly #now: () => number;
  readonly #queue: PendingApproval[] = [];
  readonly #recentRequestTimes: number[] = [];
  readonly #events: ApprovalLifecycleEvent[] = [];
  #active: ActiveApproval | null = null;
  #eventSequence = 0;

  constructor(options: ApprovalBrokerOptions) {
    this.#surface = options.surface;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#burstWindowMs = options.burstWindowMs ?? 10_000;
    this.#burstThreshold = options.burstThreshold ?? 5;
    this.#maxQueue = options.maxQueue ?? 8;
    this.#maxEvents = options.maxEvents ?? 100;
    this.#now = options.now ?? Date.now;

    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 10) {
      throw new Error("Approval timeout must be at least 10ms.");
    }
    if (!Number.isInteger(this.#burstWindowMs) || this.#burstWindowMs < 10) {
      throw new Error("Approval burst window must be at least 10ms.");
    }
    if (!Number.isInteger(this.#burstThreshold) || this.#burstThreshold < 2) {
      throw new Error("Approval burst threshold must be at least 2.");
    }
    if (!Number.isInteger(this.#maxQueue) || this.#maxQueue < 1 || this.#maxQueue > 64) {
      throw new Error("Approval queue limit must be from 1 through 64.");
    }
    if (!Number.isInteger(this.#maxEvents) || this.#maxEvents < 1 || this.#maxEvents > 1000) {
      throw new Error("Approval event limit must be from 1 through 1000.");
    }
  }

  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    const requestedAtMs = this.#now();
    this.#recentRequestTimes.push(requestedAtMs);
    while (
      this.#recentRequestTimes.length > 0 &&
      requestedAtMs - (this.#recentRequestTimes[0] ?? requestedAtMs) > this.#burstWindowMs
    ) {
      this.#recentRequestTimes.shift();
    }

    const presentation: ApprovalPresentation = {
      ...input,
      id: randomUUID(),
      requestedAt: new Date(requestedAtMs).toISOString(),
      expiresAt: new Date(requestedAtMs + this.#timeoutMs).toISOString(),
      burstDetected: this.#recentRequestTimes.length >= this.#burstThreshold,
    };
    this.#record(presentation, "requested");

    if (this.#queue.length + (this.#active === null ? 0 : 1) >= this.#maxQueue) {
      this.#record(presentation, "queue-overflow", { reason: "queue-overflow" });
      return Promise.resolve("deny");
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const pending: PendingApproval = { presentation, resolve };
      this.#queue.push(pending);
      this.#record(presentation, "queued");
      this.#drain();
    });
  }

  cancelAll(reason: ApprovalCancellationReason = "cancelled"): void {
    const active = this.#active;
    if (active !== null) {
      active.cancel(reason);
    }
    while (this.#queue.length > 0) {
      const pending = this.#queue.shift();
      if (pending === undefined) {
        break;
      }
      this.#record(pending.presentation, "cancelled", { reason });
      pending.resolve("deny");
    }
  }

  events(): readonly ApprovalLifecycleEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  pendingCount(): number {
    return this.#queue.length + (this.#active === null ? 0 : 1);
  }

  #drain(): void {
    if (this.#active !== null) {
      return;
    }
    const pending = this.#queue.shift();
    if (pending === undefined) {
      return;
    }

    const abortController = new AbortController();
    let settled = false;
    let cancelResolve: ((decision: ApprovalDecision) => void) | null = null;
    let cancelReason: ApprovalCancellationReason | null = null;
    const cancellation = new Promise<ApprovalDecision>((resolve) => {
      cancelResolve = resolve;
    });
    const cancel = (reason: ApprovalCancellationReason): void => {
      if (settled || cancelResolve === null) {
        return;
      }
      cancelReason = reason;
      abortController.abort();
      cancelResolve("deny");
    };

    this.#active = { pending, abortController, cancel };
    this.#record(pending.presentation, "presented");
    const timeout = setTimeout(() => cancel("timeout"), this.#timeoutMs);
    const surface = this.#surface.present(pending.presentation, abortController.signal).catch((): ApprovalDecision => {
      cancelReason ??= "surface-error";
      return "deny";
    });

    void Promise.race([surface, cancellation]).then((decision) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const reason = cancelReason;
      if (reason === null) {
        this.#record(pending.presentation, "resolved", { decision });
      } else {
        this.#record(pending.presentation, "cancelled", { reason });
      }
      this.#active = null;
      pending.resolve(decision);
      this.#drain();
    });
  }

  #record(
    presentation: ApprovalPresentation,
    kind: ApprovalLifecycleKind,
    extra: { readonly decision?: ApprovalDecision; readonly reason?: ApprovalCancellationReason } = {},
  ): void {
    this.#eventSequence += 1;
    const event: ApprovalLifecycleEvent = {
      sequence: this.#eventSequence,
      occurredAt: new Date(this.#now()).toISOString(),
      requestId: presentation.id,
      toolName: presentation.toolName,
      kind,
      queueDepth: this.#queue.length + (this.#active === null ? 0 : 1),
      burstDetected: presentation.burstDetected,
      ...(extra.decision === undefined ? {} : { decision: extra.decision }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    };
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }
}
