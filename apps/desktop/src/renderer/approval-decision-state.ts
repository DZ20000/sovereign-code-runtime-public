import type { DesktopApprovalDecision, DesktopApprovalView, SovereignApprovalApi } from "../shared.js";

export type ApprovalPhase = "loading" | "pending" | "submitting" | "expired" | "uncertain" | "unavailable";

/** One local decision attempt per presentation; a missing acknowledgement never authorizes a replay. */
export class ApprovalDecisionState {
  current: DesktopApprovalView | null = null;
  phase: ApprovalPhase = "loading";

  constructor(
    private readonly api: Pick<SovereignApprovalApi, "getCurrent" | "resolve">,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      this.current = await this.api.getCurrent();
      this.phase = this.current === null ? "unavailable" : "pending";
      this.tick();
    } catch {
      this.phase = "unavailable";
    }
    this.changed();
  }

  remainingSeconds(): number {
    const expiresAt = this.current === null ? NaN : Date.parse(this.current.expiresAt);
    return Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - this.now()) / 1_000)) : 0;
  }

  tick(): void {
    if (this.phase === "pending" && this.remainingSeconds() === 0) {
      this.phase = "expired";
    }
    this.changed();
  }

  async decide(decision: DesktopApprovalDecision): Promise<void> {
    this.tick();
    if (this.current === null || this.phase !== "pending") return;
    if (decision === "drop-to-l1" && !this.current.burstDetected) return;
    if (decision === "allow-once" && this.current.context?.administratorRequired === true) return;
    this.phase = "submitting";
    this.changed();
    try {
      await this.api.resolve(this.current.id, decision);
      // The trusted surface closes on acknowledgement. Stay disabled until it does.
    } catch {
      this.phase = "uncertain";
      this.changed();
    }
  }
}
