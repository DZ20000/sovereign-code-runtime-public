import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type {
  DesktopRuntimeCutoverCanary,
  DesktopRuntimeCutoverCheckpoint,
  DesktopRuntimeCutoverCheckpointInput,
  DesktopRuntimeCutoverDetachInput,
  DesktopRuntimeCutoverDrainInput,
  DesktopRuntimeCutoverDrainReport,
  DesktopRuntimeCutoverPromoteInput,
  DesktopRuntimeCutoverResumeInput,
  DesktopRuntimeCutoverRole,
  DesktopRuntimeCutoverStatus,
  DesktopRuntimeTrafficStatus,
} from "@sovereign/control-plane-contract";
import {
  DESKTOP_RUNTIME_CUTOVER_CANARY_SCHEMA_VERSION,
  DESKTOP_RUNTIME_CUTOVER_CHECKPOINT_SCHEMA_VERSION,
  DESKTOP_RUNTIME_CUTOVER_DRAIN_SCHEMA_VERSION,
  DESKTOP_RUNTIME_CUTOVER_STATUS_SCHEMA_VERSION,
} from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

const CUTOVER_METHODS = new Set<string>([
  "cutover.status",
  "cutover.quiesce",
  "cutover.drain",
  "cutover.checkpoint",
  "cutover.detach",
  "cutover.resume",
  "cutover.promote",
  "cutover.canary",
]);

const PASSIVE_CANDIDATE_METHODS = new Set<string>([
  "state.get",
  "manifest.get",
  "audit.list",
  "runs.list",
  "runs.get",
  "tasks.snapshot",
  "tasks.get",
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const FENCING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CHECKPOINT_STATE_BYTES = 4 * 1_024 * 1_024;

export interface RuntimeGatewayDrainReport extends DesktopRuntimeTrafficStatus {
  readonly drained: boolean;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly waitedMs: number;
}

export interface RuntimeCutoverHostAdapter {
  trafficStatus(): DesktopRuntimeTrafficStatus | null;
  quiesceTraffic(): DesktopRuntimeTrafficStatus | null;
  waitForTrafficIdle(
    expectedGeneration: number,
    timeoutMs: number,
  ): Promise<RuntimeGatewayDrainReport>;
  resumeTraffic(expectedGeneration: number): DesktopRuntimeTrafficStatus;
  externalRouteDesired(): boolean;
  detachExternalTraffic(checkpointId: string): Promise<void>;
  resumeExternalTraffic(
    checkpointId: string,
    externalRouteDesired: boolean,
  ): Promise<void>;
  snapshot(): Promise<unknown>;
  promote(checkpointId: string, externalRouteDesired: boolean): Promise<void>;
  canary(): Promise<unknown>;
}

export interface RuntimeCutoverGateOptions {
  readonly instanceId: string;
  readonly releaseId: string;
  readonly role: DesktopRuntimeCutoverRole;
  readonly adapter: RuntimeCutoverHostAdapter;
  readonly promotionFencingToken?: string;
  readonly now?: () => number;
}

interface ControlDrainReport {
  readonly drained: boolean;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly waitedMs: number;
  readonly activeRequestCount: number;
}

interface StoredCheckpoint {
  readonly checkpointId: string;
  readonly fencingTokenSha256: string;
  readonly stateSha256: string;
  readonly externalRouteDesired: boolean;
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new RuntimeError("INVALID_INPUT", `${label} is invalid.`, 400);
  }
}

function assertGeneration(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must be a non-negative safe integer.`,
      400,
    );
  }
}

function assertTimeout(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 300_000
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Runtime cutover drain timeout must be from 1 through 300000 milliseconds.",
      400,
    );
  }
}

function assertFencingToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !FENCING_TOKEN_PATTERN.test(value)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Runtime cutover fencing token must be canonical 256-bit base64url.",
      400,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function snapshotSha256(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(canonicalize(value));
  } catch (error) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      `Runtime cutover checkpoint state is not serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }
  if (serialized === undefined) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      "Runtime cutover checkpoint state has no JSON representation.",
      500,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_STATE_BYTES) {
    throw new RuntimeError(
      "FILE_TOO_LARGE",
      "Runtime cutover checkpoint state exceeds its bounded size limit.",
      500,
    );
  }
  return sha256(serialized);
}

function safeTokenEqual(left: string, right: string): boolean {
  if (!FENCING_TOKEN_PATTERN.test(left) || !FENCING_TOKEN_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeSha256Equal(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createRuntimeCutoverFencingToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isRuntimeCutoverMethod(method: string): boolean {
  return CUTOVER_METHODS.has(method);
}

export class RuntimeCutoverGate {
  readonly #instanceId: string;
  readonly #releaseId: string;
  readonly #adapter: RuntimeCutoverHostAdapter;
  readonly #now: () => number;
  readonly #startedAtUnixMs: number;
  readonly #promotionFencingToken: string | null;
  readonly #controlWaiters = new Set<() => void>();
  #role: DesktopRuntimeCutoverRole;
  #promoted: boolean;
  #promotedCheckpointId: string | null = null;
  #externalRouteDesired: boolean;
  #trafficDetached = false;
  #controlQuiesced = false;
  #controlGeneration = 0;
  #activeControlRequestCount = 0;
  #checkpoint: StoredCheckpoint | null = null;

  constructor(options: RuntimeCutoverGateOptions) {
    assertIdentifier(options.instanceId, "Runtime instance ID");
    assertIdentifier(options.releaseId, "Runtime release ID");
    if (options.role !== "active" && options.role !== "candidate") {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime cutover role is invalid.",
        400,
      );
    }
    if (typeof options.adapter !== "object" || options.adapter === null) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime cutover adapter is required.",
        400,
      );
    }
    if (options.promotionFencingToken !== undefined) {
      assertFencingToken(options.promotionFencingToken);
    }
    if (
      options.role === "candidate" &&
      options.promotionFencingToken === undefined
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "A passive Runtime Host candidate requires a promotion fencing token.",
        400,
      );
    }
    this.#instanceId = options.instanceId;
    this.#releaseId = options.releaseId;
    this.#role = options.role;
    this.#promoted = options.role === "active";
    this.#adapter = options.adapter;
    this.#promotionFencingToken = options.promotionFencingToken ?? null;
    this.#externalRouteDesired =
      options.role === "active"
        ? options.adapter.externalRouteDesired()
        : false;
    this.#now = options.now ?? Date.now;
    this.#startedAtUnixMs = this.#now();
  }

  admit(method: string): () => void {
    if (CUTOVER_METHODS.has(method) || method === "shutdown") {
      return () => undefined;
    }
    if (this.#controlQuiesced) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "The Runtime Host control plane is quiesced for a verified cutover.",
        503,
      );
    }
    if (!this.#promoted && !PASSIVE_CANDIDATE_METHODS.has(method)) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Passive Runtime Host candidate denied control method ${method}.`,
        403,
      );
    }

    this.#activeControlRequestCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeControlRequestCount = Math.max(
        0,
        this.#activeControlRequestCount - 1,
      );
      this.#notifyControlWaiters();
    };
  }

  status(): DesktopRuntimeCutoverStatus {
    if (this.#promoted && !this.#trafficDetached && this.#checkpoint === null) {
      this.#externalRouteDesired = this.#adapter.externalRouteDesired();
    }
    return {
      schemaVersion: DESKTOP_RUNTIME_CUTOVER_STATUS_SCHEMA_VERSION,
      instanceId: this.#instanceId,
      releaseId: this.#releaseId,
      role: this.#role,
      promoted: this.#promoted,
      promotedCheckpointId: this.#promotedCheckpointId,
      controlQuiesced: this.#controlQuiesced,
      controlGeneration: this.#controlGeneration,
      activeControlRequestCount: this.#activeControlRequestCount,
      gateway: this.#adapter.trafficStatus(),
      checkpointId: this.#checkpoint?.checkpointId ?? null,
      externalRouteDesired: this.#externalRouteDesired,
      trafficDetached: this.#trafficDetached,
      startedAtUnixMs: this.#startedAtUnixMs,
    };
  }

  quiesce(): DesktopRuntimeCutoverStatus {
    this.#assertPromotedAuthority("quiesce");
    if (!this.#controlQuiesced) {
      this.#controlQuiesced = true;
      this.#controlGeneration += 1;
      this.#adapter.quiesceTraffic();
      this.#notifyControlWaiters();
    }
    return this.status();
  }

  async drain(
    input: DesktopRuntimeCutoverDrainInput,
  ): Promise<DesktopRuntimeCutoverDrainReport> {
    this.#assertPromotedAuthority("drain");
    assertGeneration(input.controlGeneration, "Runtime control generation");
    assertTimeout(input.timeoutMs);
    this.#assertControlFence(input.controlGeneration);
    const gateway = this.#assertGatewayFence(input.gatewayGeneration);
    const startedAt = this.#now();
    const [control, gatewayDrain] = await Promise.all([
      this.#waitForControlIdle(input.controlGeneration, input.timeoutMs),
      gateway === null
        ? Promise.resolve(null)
        : this.#adapter.waitForTrafficIdle(gateway.generation, input.timeoutMs),
    ]);
    const activeGatewayRequestCount = gatewayDrain?.activeRequestCount ?? 0;
    const drained = control.drained && (gatewayDrain?.drained ?? true);
    const timedOut = control.timedOut || (gatewayDrain?.timedOut ?? false);
    const interrupted =
      control.interrupted || (gatewayDrain?.interrupted ?? false);
    const activeTotal = control.activeRequestCount + activeGatewayRequestCount;
    return {
      schemaVersion: DESKTOP_RUNTIME_CUTOVER_DRAIN_SCHEMA_VERSION,
      controlGeneration: this.#controlGeneration,
      gatewayGeneration: gatewayDrain?.generation ?? null,
      drained,
      timedOut,
      interrupted,
      waitedMs: Math.max(
        control.waitedMs,
        gatewayDrain?.waitedMs ?? 0,
        Math.max(0, this.#now() - startedAt),
      ),
      activeControlRequestCount: control.activeRequestCount,
      activeGatewayRequestCount,
      unknownOutcomeCount: drained ? 0 : Math.max(1, activeTotal),
    };
  }

  async checkpoint(
    input: DesktopRuntimeCutoverCheckpointInput,
  ): Promise<DesktopRuntimeCutoverCheckpoint> {
    this.#assertPromotedAuthority("checkpoint");
    assertGeneration(input.controlGeneration, "Runtime control generation");
    assertFencingToken(input.fencingToken);
    this.#assertControlFence(input.controlGeneration);
    const gateway = this.#assertGatewayFence(input.gatewayGeneration);
    if (this.#trafficDetached) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime traffic is already detached; create no new checkpoint.",
        409,
      );
    }
    if (this.#activeControlRequestCount !== 0) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Runtime control requests are still active; checkpoint is unsafe.",
        409,
      );
    }
    if (
      gateway !== null &&
      (gateway.acceptingRequests || gateway.activeRequestCount !== 0)
    ) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Gateway requests are still active; checkpoint is unsafe.",
        409,
      );
    }

    this.#externalRouteDesired = this.#adapter.externalRouteDesired();
    const stateSha256 = snapshotSha256({
      schemaVersion: "scr.runtime-cutover-checkpoint-state/v1",
      externalRouteDesired: this.#externalRouteDesired,
      state: await this.#adapter.snapshot(),
    });
    const checkpointId = randomUUID();
    this.#checkpoint = {
      checkpointId,
      fencingTokenSha256: sha256(input.fencingToken),
      stateSha256,
      externalRouteDesired: this.#externalRouteDesired,
    };
    return {
      schemaVersion: DESKTOP_RUNTIME_CUTOVER_CHECKPOINT_SCHEMA_VERSION,
      checkpointId,
      fencingToken: input.fencingToken,
      instanceId: this.#instanceId,
      releaseId: this.#releaseId,
      controlGeneration: this.#controlGeneration,
      gatewayGeneration: gateway?.generation ?? null,
      stateSha256,
      externalRouteDesired: this.#externalRouteDesired,
      createdAtUnixMs: this.#now(),
    };
  }

  async detach(
    input: DesktopRuntimeCutoverDetachInput,
  ): Promise<DesktopRuntimeCutoverStatus> {
    this.#assertPromotedAuthority("detach external traffic");
    assertGeneration(input.controlGeneration, "Runtime control generation");
    this.#assertControlFence(input.controlGeneration);
    const gateway = this.#assertGatewayFence(input.gatewayGeneration);
    const checkpoint = this.#assertStoredCheckpoint(
      input.checkpointId,
      input.fencingToken,
    );
    if (this.#activeControlRequestCount !== 0) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Runtime control requests became active before traffic detach.",
        409,
      );
    }
    if (
      gateway !== null &&
      (gateway.acceptingRequests || gateway.activeRequestCount !== 0)
    ) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Gateway traffic became active before external traffic detach.",
        409,
      );
    }
    if (!this.#trafficDetached) {
      await this.#adapter.detachExternalTraffic(checkpoint.checkpointId);
      this.#trafficDetached = true;
    }
    return this.status();
  }

  async resume(
    input: DesktopRuntimeCutoverResumeInput,
  ): Promise<DesktopRuntimeCutoverStatus> {
    this.#assertPromotedAuthority("resume");
    assertGeneration(input.controlGeneration, "Runtime control generation");
    this.#assertControlFence(input.controlGeneration);
    const gateway = this.#assertGatewayFence(input.gatewayGeneration);
    const resumedGateway =
      gateway === null ? null : this.#adapter.resumeTraffic(gateway.generation);
    try {
      if (this.#trafficDetached) {
        const checkpoint = this.#checkpoint;
        if (checkpoint === null) {
          throw new RuntimeError(
            "PROCESS_FAILED",
            "Detached Runtime Host traffic has no checkpoint for restoration.",
            500,
          );
        }
        await this.#adapter.resumeExternalTraffic(
          checkpoint.checkpointId,
          checkpoint.externalRouteDesired,
        );
      }
    } catch (error) {
      if (resumedGateway !== null) {
        try {
          this.#adapter.quiesceTraffic();
        } catch {
          // Preserve the original route-restoration error; status exposes the new fence.
        }
      }
      throw error;
    }
    this.#trafficDetached = false;
    this.#controlQuiesced = false;
    this.#controlGeneration += 1;
    this.#checkpoint = null;
    this.#notifyControlWaiters();
    return this.status();
  }

  async promote(
    input: DesktopRuntimeCutoverPromoteInput,
  ): Promise<DesktopRuntimeCutoverStatus> {
    assertIdentifier(input.checkpointId, "Runtime checkpoint ID");
    assertFencingToken(input.fencingToken);
    if (typeof input.externalRouteDesired !== "boolean") {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime promotion external route intent must be boolean.",
        400,
      );
    }
    if (this.#role !== "candidate" || this.#promoted) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Only an unpromoted Runtime Host candidate can be promoted.",
        409,
      );
    }
    if (
      this.#promotionFencingToken === null ||
      !safeTokenEqual(input.fencingToken, this.#promotionFencingToken)
    ) {
      throw new RuntimeError(
        "AUTH_INVALID",
        "Runtime Host candidate promotion fencing token is invalid.",
        401,
      );
    }

    await this.#adapter.promote(input.checkpointId, input.externalRouteDesired);
    this.#promoted = true;
    this.#role = "active";
    this.#promotedCheckpointId = input.checkpointId;
    this.#externalRouteDesired = input.externalRouteDesired;
    return this.status();
  }

  async canary(): Promise<DesktopRuntimeCutoverCanary> {
    this.#assertPromotedAuthority("canary");
    const stateSha256 = snapshotSha256(await this.#adapter.canary());
    if (!SHA256_PATTERN.test(stateSha256)) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Runtime Host canary produced an invalid state digest.",
        500,
      );
    }
    return {
      schemaVersion: DESKTOP_RUNTIME_CUTOVER_CANARY_SCHEMA_VERSION,
      instanceId: this.#instanceId,
      releaseId: this.#releaseId,
      promoted: this.#promoted,
      promotedCheckpointId: this.#promotedCheckpointId,
      externalRouteDesired: this.#externalRouteDesired,
      stateSha256,
      checkedAtUnixMs: this.#now(),
    };
  }

  #assertPromotedAuthority(operation: string): void {
    if (!this.#promoted || this.#role !== "active") {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Only an authoritative Runtime Host may ${operation}.`,
        409,
      );
    }
  }

  #assertStoredCheckpoint(
    checkpointId: unknown,
    fencingToken: unknown,
  ): StoredCheckpoint {
    assertIdentifier(checkpointId, "Runtime checkpoint ID");
    assertFencingToken(fencingToken);
    const checkpoint = this.#checkpoint;
    if (checkpoint === null) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime Host has no active cutover checkpoint.",
        409,
      );
    }
    if (checkpoint.checkpointId !== checkpointId) {
      throw new RuntimeError(
        "STALE_HASH",
        "Runtime checkpoint ID changed before traffic detach.",
        409,
      );
    }
    if (!safeSha256Equal(checkpoint.fencingTokenSha256, sha256(fencingToken))) {
      throw new RuntimeError(
        "AUTH_INVALID",
        "Runtime checkpoint fencing token is invalid.",
        401,
      );
    }
    return checkpoint;
  }

  #assertControlFence(expectedGeneration: number): void {
    if (!this.#controlQuiesced) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime control traffic must be quiesced before this operation.",
        409,
      );
    }
    if (this.#controlGeneration !== expectedGeneration) {
      throw new RuntimeError(
        "STALE_HASH",
        `Runtime control generation changed: expected ${expectedGeneration}, observed ${this.#controlGeneration}.`,
        409,
      );
    }
  }

  #assertGatewayFence(
    expectedGeneration: number | null,
  ): DesktopRuntimeTrafficStatus | null {
    const gateway = this.#adapter.trafficStatus();
    if (gateway === null) {
      if (expectedGeneration !== null) {
        throw new RuntimeError(
          "STALE_HASH",
          "Runtime candidate has no Gateway but a Gateway generation was supplied.",
          409,
        );
      }
      return null;
    }
    if (expectedGeneration === null) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime Gateway generation is required.",
        400,
      );
    }
    assertGeneration(expectedGeneration, "Runtime Gateway generation");
    if (gateway.generation !== expectedGeneration) {
      throw new RuntimeError(
        "STALE_HASH",
        `Runtime Gateway generation changed: expected ${expectedGeneration}, observed ${gateway.generation}.`,
        409,
      );
    }
    return gateway;
  }

  async #waitForControlIdle(
    expectedGeneration: number,
    timeoutMs: number,
  ): Promise<ControlDrainReport> {
    const startedAt = this.#now();
    const report = (
      drained: boolean,
      timedOut: boolean,
      interrupted: boolean,
    ): ControlDrainReport => ({
      drained,
      timedOut,
      interrupted,
      waitedMs: Math.max(0, this.#now() - startedAt),
      activeRequestCount: this.#activeControlRequestCount,
    });
    if (this.#activeControlRequestCount === 0) {
      return report(true, false, false);
    }

    return await new Promise<ControlDrainReport>((resolveDrain) => {
      let completed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (
        drained: boolean,
        timedOut: boolean,
        interrupted: boolean,
      ): void => {
        if (completed) return;
        completed = true;
        this.#controlWaiters.delete(check);
        if (timer !== null) clearTimeout(timer);
        resolveDrain(report(drained, timedOut, interrupted));
      };
      const check = (): void => {
        if (
          !this.#controlQuiesced ||
          this.#controlGeneration !== expectedGeneration
        ) {
          finish(false, false, true);
          return;
        }
        if (this.#activeControlRequestCount === 0) {
          finish(true, false, false);
        }
      };
      this.#controlWaiters.add(check);
      timer = setTimeout(() => finish(false, true, false), timeoutMs);
      timer.unref?.();
      check();
    });
  }

  #notifyControlWaiters(): void {
    for (const waiter of [...this.#controlWaiters]) {
      try {
        waiter();
      } catch {
        // Waiters are isolated from one another.
      }
    }
  }
}
