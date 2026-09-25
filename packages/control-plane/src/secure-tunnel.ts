import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  controlPlaneAttemptHealthFileName,
  redactControlPlaneDiagnostic,
  sanitizeTunnelChildEnvironment,
} from "./control-plane-failover.js";
import {
  classifyTunnelFailureEvidence, connectorReportsOwnRetry,
  tunnelFailureClassificationPriority,
  type TunnelFailureClassification,
  type TunnelFailureDiagnostic,
  type TunnelFailureEvidenceSource,
} from "./tunnel-failure-classifier.js";
import {
  normalizeSecureTunnelControlPlaneProxyUrl,
  secureTunnelProxyDisplay,
} from "./settings.js";
import {
  boundedAppend,
  isMissingFileError,
  normalizeAttemptInstanceId,
  normalizeReconnectDelays,
  positiveInteger,
  readLoopbackHealthUrl,
  resolveTunnelClient,
  sha256File,
  spawnConnectorProcess,
  terminateChild,
  validateGatewayEndpoint,
  validateRuntimeApiKey,
  validateTunnelId,
  waitForChildExit,
} from "./secure-tunnel-support.js";
import { CONTROL_PLANE_FIRST_POLL_DEADLINE_MS, CONTROL_PLANE_POLL_FRESHNESS_MS, judgeControlPlanePoll } from "./tunnel-control-plane-poll.js";
import { askConnectorReadiness, CONNECTOR_PROBE_TIMEOUT_MS } from "./tunnel-readiness-probe.js";

const MAX_CONNECTOR_LOG_LINE_CHARACTERS = 1_048_576;
const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_READY_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_STABILITY_WINDOW_MS = 30_000;
const READINESS_FAILURES_BEFORE_RECYCLE = 3;

export type SecureTunnelPhase =
  | "unavailable"
  | "stopped"
  | "starting"
  | "running"
  | "ready"
  | "stopping"
  | "error";

export interface SecureTunnelState {
  readonly phase: SecureTunnelPhase;
  readonly clientAvailable: boolean;
  readonly executablePath: string | null;
  readonly executableSha256: string | null;
  readonly executableTrusted: boolean;
  readonly tunnelId: string | null;
  readonly processId: number | null;
  readonly hasRuntimeApiKey: boolean;
  readonly controlPlaneProxyConfigured: boolean;
  readonly controlPlaneProxyDisplay: string | null;
  readonly autoReconnect: boolean;
  readonly desiredRunning: boolean;
  readonly reconnectAttempt: number;
  readonly nextReconnectAt: string | null;
  readonly lastReadyAt: string | null;
  readonly healthUrl: string | null;
  readonly errorMessage: string | null;
  readonly failureDiagnostic: TunnelFailureDiagnostic | null;
  readonly logTail: string;
}

export interface SecureTunnelRefreshOptions {
  readonly networkChanged?: boolean;
}

export interface SecureTunnelConfiguration {
  readonly tunnelId: string | null;
  readonly runtimeApiKey?: string;
  readonly clearRuntimeApiKey?: boolean;
  readonly trustedExecutableSha256?: string | null;
  readonly executablePath?: string | null;
  readonly controlPlaneProxyUrl?: string | null;
}

interface SecureTunnelStartOptions {
  readonly gatewayEndpoint: string;
  readonly gatewayBearerToken: string;
}

export type SpawnConnector = (
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type TerminateConnector = (child: ChildProcess) => Promise<void>;

export interface SecureTunnelControllerOptions {
  readonly healthUrlFile: string;
  readonly configuredExecutablePath?: string | null;
  readonly packagedExecutablePath?: string;
  readonly onStateChanged?: () => void;
  readonly reconnectDelaysMs?: readonly number[];
  readonly healthProbeIntervalMs?: number;
  readonly startupReadyTimeoutMs?: number;
  readonly reconnectStabilityWindowMs?: number;
  readonly controlPlanePollDeadlineMs?: number;
  readonly controlPlanePollFreshnessMs?: number;
  readonly localProbeTimeoutMs?: number;
  readonly attemptInstanceId?: string;
  readonly spawnConnector?: SpawnConnector;
  readonly terminateConnector?: TerminateConnector;
}

export class SecureMcpTunnelController {
  readonly #healthUrlFile: string;
  readonly #packagedExecutablePath: string | undefined;
  readonly #onStateChanged: (() => void) | undefined;
  readonly #attemptDirectory: string;
  readonly #spawnConnector: SpawnConnector;
  readonly #terminateConnector: TerminateConnector;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #healthProbeIntervalMs: number;
  readonly #startupReadyTimeoutMs: number;
  readonly #reconnectStabilityWindowMs: number;
  readonly #controlPlanePoll: { readonly deadlineMs: number; readonly freshnessMs: number };
  readonly #localProbeTimeoutMs: number;
  #configuredExecutablePath: string | null;
  #executablePath: string | null;
  #executableSha256: string | null = null;
  #trustedExecutableSha256: string | null = null;
  #tunnelId: string | null = null;
  #runtimeApiKey: string | null = null;
  #controlPlaneProxyUrl: string | null = null;
  #phase: SecureTunnelPhase = "unavailable";
  #healthUrl: string | null = null;
  #errorMessage: string | null = null;
  #failureDiagnostic: TunnelFailureDiagnostic | null = null;
  #failureDiagnosticGeneration = 0;
  #logTail = "";
  #connectorLogCarry = "";
  #child: ChildProcess | null = null;
  #autoReconnect = false;
  #desiredRunning = false;
  #reconnectAttempt = 0;
  #nextReconnectAt: string | null = null;
  #lastReadyAt: string | null = null;
  #readySinceMs: number | null = null;
  #readyStabilityTimer: NodeJS.Timeout | null = null;
  #hadReadyConnection = false;
  #consecutiveReadinessFailures = 0;
  #unanswered: { readonly generation: number; readonly sinceMs: number } | null = null;
  #recycleGeneration: number | null = null;
  #lastStartOptions: SecureTunnelStartOptions | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #healthTimer: NodeJS.Timeout | null = null;
  #healthProbeGeneration: number | null = null;
  #attemptGeneration = 0;
  #activeHealthUrlFile: string | null = null;
  #activePidFile: string | null = null;
  #attemptStartedAtMs = 0;

  constructor(options: SecureTunnelControllerOptions) {
    this.#healthUrlFile = options.healthUrlFile;
    const attemptInstanceId = normalizeAttemptInstanceId(options.attemptInstanceId);
    this.#attemptDirectory = join(dirname(options.healthUrlFile), `instance-${attemptInstanceId}`);
    this.#spawnConnector = options.spawnConnector ?? spawnConnectorProcess;
    this.#terminateConnector = options.terminateConnector ?? terminateChild;
    this.#configuredExecutablePath = options.configuredExecutablePath?.trim() || null;
    this.#packagedExecutablePath = options.packagedExecutablePath;
    this.#onStateChanged = options.onStateChanged;
    this.#reconnectDelaysMs = normalizeReconnectDelays(options.reconnectDelaysMs);
    this.#healthProbeIntervalMs = positiveInteger(
      options.healthProbeIntervalMs,
      DEFAULT_HEALTH_PROBE_INTERVAL_MS,
      "Tunnel health probe interval",
    );
    this.#startupReadyTimeoutMs = positiveInteger(
      options.startupReadyTimeoutMs,
      DEFAULT_STARTUP_READY_TIMEOUT_MS,
      "Tunnel startup readiness timeout",
    );
    this.#reconnectStabilityWindowMs = positiveInteger(
      options.reconnectStabilityWindowMs,
      DEFAULT_RECONNECT_STABILITY_WINDOW_MS,
      "Tunnel reconnect stability window",
    );
    this.#controlPlanePoll = {
      deadlineMs: positiveInteger(options.controlPlanePollDeadlineMs, CONTROL_PLANE_FIRST_POLL_DEADLINE_MS, "Control-plane first poll deadline"),
      freshnessMs: positiveInteger(options.controlPlanePollFreshnessMs, CONTROL_PLANE_POLL_FRESHNESS_MS, "Control-plane poll freshness"),
    };
    this.#localProbeTimeoutMs = positiveInteger(options.localProbeTimeoutMs, CONNECTOR_PROBE_TIMEOUT_MS, "Local connector probe timeout");
    this.#executablePath = resolveTunnelClient(
      this.#configuredExecutablePath,
      this.#packagedExecutablePath,
    );
    this.#refreshExecutable();
  }

  #beginAttempt(): {
    readonly generation: number;
    readonly healthUrlFile: string;
    readonly pidFile: string;
    readonly startedAtMs: number;
  } {
    if (this.#attemptGeneration >= 2_147_483_647) {
      throw new Error("Tunnel attempt generation limit was reached; restart Sovereign.");
    }
    this.#attemptGeneration += 1;
    this.#markReadinessUnstable();
    this.#hadReadyConnection = false;
    this.#consecutiveReadinessFailures = 0;
    const generation = this.#attemptGeneration;
    const healthUrlFile = join(
      this.#attemptDirectory,
      controlPlaneAttemptHealthFileName(generation),
    );
    const pidFile = join(this.#attemptDirectory, `attempt-${generation}.pid`);
    const startedAtMs = Date.now();
    this.#activeHealthUrlFile = healthUrlFile;
    this.#activePidFile = pidFile;
    this.#attemptStartedAtMs = startedAtMs;
    return { generation, healthUrlFile, pidFile, startedAtMs };
  }

  #invalidateAttempt(): void {
    this.#markReadinessUnstable();
    if (this.#attemptGeneration < 2_147_483_647) {
      this.#attemptGeneration += 1;
    }
    this.#activeHealthUrlFile = null;
    this.#activePidFile = null;
    this.#attemptStartedAtMs = 0;
    this.#healthUrl = null;
  }

  #isCurrentAttempt(generation: number, child: ChildProcess): boolean {
    return this.#attemptGeneration === generation && this.#child === child;
  }

  #redactConnectorLog(value: string): string {
    const bearer = this.#lastStartOptions?.gatewayBearerToken;
    return redactControlPlaneDiagnostic(value, [
      this.#runtimeApiKey ?? "",
      this.#controlPlaneProxyUrl ?? "",
      bearer ?? "",
      bearer === undefined ? "" : `Bearer ${bearer}`,
    ]);
  }

  #appendConnectorLog(chunk: string): void {
    this.#connectorLogCarry += chunk;
    while (true) {
      const newlineIndex = this.#connectorLogCarry.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.#connectorLogCarry.slice(0, newlineIndex + 1);
      this.#connectorLogCarry = this.#connectorLogCarry.slice(newlineIndex + 1);
      const redacted = this.#redactConnectorLog(line);
      this.#logTail = boundedAppend(this.#logTail, redacted);
      this.#recordConnectorLogClassification(redacted, this.#attemptGeneration);
    }
    if (this.#connectorLogCarry.length > MAX_CONNECTOR_LOG_LINE_CHARACTERS) {
      this.#connectorLogCarry = "";
      this.#logTail = boundedAppend(this.#logTail, "[oversized connector log line removed]\n");
    }
  }

  #flushConnectorLog(generation: number): void {
    if (this.#connectorLogCarry.length === 0) {
      return;
    }
    const redacted = this.#redactConnectorLog(this.#connectorLogCarry);
    this.#logTail = boundedAppend(this.#logTail, redacted);
    this.#recordConnectorLogClassification(redacted, generation);
    this.#connectorLogCarry = "";
  }

  #recordFailureClassification(
    classification: TunnelFailureClassification,
    generation: number,
  ): void {
    if (generation !== this.#attemptGeneration) {
      return;
    }
    const current = this.#failureDiagnostic;
    if (current !== null) {
      const currentPriority = tunnelFailureClassificationPriority(current);
      const nextPriority = tunnelFailureClassificationPriority(classification);
      if (
        currentPriority > nextPriority ||
        (this.#failureDiagnosticGeneration === generation && currentPriority >= nextPriority)
      ) {
        return;
      }
    }
    this.#failureDiagnostic = {
      ...classification,
      observedAt: new Date().toISOString(),
    };
    this.#failureDiagnosticGeneration = generation;
    if (this.#requiresLocalAction()) this.#cancelReconnectTimer();
  }

  #recordFailureEvidence(
    source: TunnelFailureEvidenceSource,
    text: string,
    generation: number,
    statusCode?: number,
  ): void {
    const redactedText = this.#redactConnectorLog(text);
    const classification = classifyTunnelFailureEvidence({
      source,
      redactedText,
      ...(statusCode === undefined ? {} : { statusCode }),
      controlPlaneProxyConfigured: this.#controlPlaneProxyUrl !== null,
    });
    this.#recordFailureClassification(classification, generation);
  }

  #recordConnectorLogClassification(redactedLine: string, generation: number): void {
    const classification = classifyTunnelFailureEvidence({
      source: "connector-log",
      redactedText: redactedLine,
      controlPlaneProxyConfigured: this.#controlPlaneProxyUrl !== null,
    });
    if (classification.evidenceCode === "log-unclassified") {
      return;
    }
    // A log line cannot overrule the polls. While the attempt is ready its polls
    // are completing, so a failure it logs is one request, and a route that has
    // really gone is caught once they stop. A line announcing the connector's own
    // retry is advisory too, judged on the whole line: the retry field can sit
    // past the excerpt the diagnostic keeps.
    const advisory = this.#phase === "ready" ||
      connectorReportsOwnRetry({ source: "connector-log", detail: redactedLine });
    // Advisory transport logs remain in logTail, not in the decisive failure
    // slot: they must not mask a later failed poll or local health probe.
    if (advisory && classification.failureClass === "transport") return;
    this.#recordFailureClassification(classification, generation);
    if (classification.routeSwitchEligible && this.#hadReadyConnection) {
      this.#requestAttemptRecycle(
        generation,
        "Secure MCP Tunnel lost its control-plane transport after reaching readiness.",
      );
    }
  }

  #clearFailureDiagnostic(): void {
    this.#failureDiagnostic = null;
    this.#failureDiagnosticGeneration = this.#attemptGeneration;
  }

  async #removeAttemptFiles(
    healthUrlFile: string | null,
    pidFile: string | null,
  ): Promise<void> {
    await Promise.all([
      healthUrlFile === null ? Promise.resolve() : rm(healthUrlFile, { force: true }),
      pidFile === null ? Promise.resolve() : rm(pidFile, { force: true }),
    ]).catch(() => undefined);
  }

  state(): SecureTunnelState {
    return {
      phase: this.#phase,
      clientAvailable: this.#executablePath !== null,
      executablePath: this.#executablePath,
      executableSha256: this.#executableSha256,
      executableTrusted:
        this.#executableSha256 !== null && this.#executableSha256 === this.#trustedExecutableSha256,
      tunnelId: this.#tunnelId,
      processId:
        this.#child?.exitCode === null && this.#child.signalCode === null
          ? this.#child.pid ?? null
          : null,
      hasRuntimeApiKey: this.#runtimeApiKey !== null,
      controlPlaneProxyConfigured: this.#controlPlaneProxyUrl !== null,
      controlPlaneProxyDisplay: secureTunnelProxyDisplay(this.#controlPlaneProxyUrl),
      autoReconnect: this.#autoReconnect,
      desiredRunning: this.#desiredRunning,
      reconnectAttempt: this.#reconnectAttempt,
      nextReconnectAt: this.#nextReconnectAt,
      lastReadyAt: this.#lastReadyAt,
      healthUrl: this.#healthUrl,
      errorMessage: this.#errorMessage,
      failureDiagnostic: this.#failureDiagnostic,
      logTail: this.#logTail,
    };
  }

  attemptGeneration(): number {
    return this.#attemptGeneration;
  }

  configure(input: SecureTunnelConfiguration): SecureTunnelState {
    if (this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null) {
      throw new Error("Stop Secure MCP Tunnel before changing its connector, tunnel identity, runtime key, or proxy.");
    }
    this.#cancelReconnectTimer();
    this.#desiredRunning = false;
    this.#lastStartOptions = null;
    const previousHealthUrlFile = this.#activeHealthUrlFile;
    const previousPidFile = this.#activePidFile;
    this.#invalidateAttempt();
    this.#clearFailureDiagnostic();
    void this.#removeAttemptFiles(previousHealthUrlFile, previousPidFile);
    void rm(this.#healthUrlFile, { force: true }).catch(() => undefined);
    if (input.executablePath !== undefined) {
      this.#configuredExecutablePath = input.executablePath?.trim() || null;
    }
    this.#tunnelId = input.tunnelId === null ? null : validateTunnelId(input.tunnelId);
    if (input.clearRuntimeApiKey === true) {
      this.#runtimeApiKey = null;
    } else if (input.runtimeApiKey !== undefined && input.runtimeApiKey.trim().length > 0) {
      this.#runtimeApiKey = validateRuntimeApiKey(input.runtimeApiKey);
    }
    if (input.controlPlaneProxyUrl !== undefined) {
      this.#controlPlaneProxyUrl = input.controlPlaneProxyUrl === null
        ? null
        : normalizeSecureTunnelControlPlaneProxyUrl(input.controlPlaneProxyUrl);
    }
    if (input.trustedExecutableSha256 !== undefined) {
      const trusted = input.trustedExecutableSha256?.trim().toLowerCase() ?? null;
      if (trusted !== null && !/^[a-f0-9]{64}$/u.test(trusted)) {
        throw new Error("Trusted tunnel-client SHA-256 is invalid.");
      }
      this.#trustedExecutableSha256 = trusted;
    }
    this.#reconnectAttempt = 0;
    this.#nextReconnectAt = null;
    this.#errorMessage = null;
    this.#refreshExecutable();
    this.#emit();
    return this.state();
  }

  setAutoReconnect(enabled: boolean): SecureTunnelState {
    this.#autoReconnect = enabled;
    if (!enabled) {
      this.#cancelReconnectTimer();
      this.#markReadinessUnstable();
      this.#reconnectAttempt = 0;
      this.#nextReconnectAt = null;
      if (this.#child === null || this.#child.exitCode !== null || this.#child.signalCode !== null) {
        this.#desiredRunning = false;
        this.#lastStartOptions = null;
      }
    } else if (
      this.#desiredRunning &&
      (this.#child === null || this.#child.exitCode !== null || this.#child.signalCode !== null) &&
      this.#lastStartOptions !== null
    ) {
      this.#scheduleReconnect(10);
    }
    this.#emit();
    return this.state();
  }

  trustCurrentExecutable(): string | null {
    this.#refreshExecutable();
    if (this.#executableSha256 === null) {
      return null;
    }
    this.#trustedExecutableSha256 = this.#executableSha256;
    this.#errorMessage = null;
    this.#phase = "stopped";
    this.#emit();
    return this.#trustedExecutableSha256;
  }

  async refresh(options: SecureTunnelRefreshOptions = {}): Promise<SecureTunnelState> {
    this.#refreshExecutable();
    if (
      options.networkChanged === true &&
      this.#desiredRunning &&
      this.#autoReconnect &&
      this.#lastStartOptions !== null
    ) {
      return await this.#restartForNetworkChange();
    }
    if (this.#child === null || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#healthUrl = null;
      if (this.#desiredRunning && this.#autoReconnect && this.#lastStartOptions !== null) {
        this.#scheduleReconnect();
      }
      this.#emit();
      return this.state();
    }
    const healthUrlFile = this.#activeHealthUrlFile;
    const generation = this.#attemptGeneration;
    if (healthUrlFile !== null && this.#healthProbeGeneration !== generation) {
      this.#healthProbeGeneration = generation;
      try {
        await this.#probeReadiness(
          generation,
          this.#child,
          healthUrlFile,
          this.#attemptStartedAtMs,
        );
      } finally {
        if (this.#healthProbeGeneration === generation) {
          this.#healthProbeGeneration = null;
        }
      }
    }
    this.#emit();
    return this.state();
  }

  async start(options: SecureTunnelStartOptions): Promise<SecureTunnelState> {
    if (this.#requiresLocalAction()) await this.stop();
    this.#desiredRunning = true;
    this.#markReadinessUnstable();
    this.#hadReadyConnection = false;
    this.#consecutiveReadinessFailures = 0;
    this.#lastStartOptions = { ...options };
    this.#reconnectAttempt = 0;
    this.#nextReconnectAt = null;
    this.#cancelReconnectTimer();
    try {
      return await this.#startAttempt(options);
    } catch (error) {
      this.#desiredRunning = false;
      this.#lastStartOptions = null;
      this.#cancelReconnectTimer();
      this.#emit();
      throw error;
    }
  }

  async stop(): Promise<SecureTunnelState> {
    this.#desiredRunning = false;
    this.#lastStartOptions = null;
    this.#cancelReconnectTimer();
    this.#stopHealthMonitor();
    this.#markReadinessUnstable();
    this.#reconnectAttempt = 0;
    this.#nextReconnectAt = null;
    this.#hadReadyConnection = false;
    this.#consecutiveReadinessFailures = 0;
    this.#recycleGeneration = null;
    const child = this.#child;
    const healthUrlFile = this.#activeHealthUrlFile;
    const pidFile = this.#activePidFile;
    const generation = this.#attemptGeneration;
    this.#attemptGeneration = Math.min(2_147_483_647, this.#attemptGeneration + 1);
    this.#clearFailureDiagnostic();
    this.#activeHealthUrlFile = null;
    this.#activePidFile = null;
    this.#attemptStartedAtMs = 0;
    this.#healthUrl = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.#child = null;
      await this.#removeAttemptFiles(healthUrlFile, pidFile);
      await rm(this.#healthUrlFile, { force: true }).catch(() => undefined);
      this.#refreshExecutable();
      this.#phase = this.#executablePath === null ? "unavailable" : "stopped";
      this.#errorMessage = null;
      this.#emit();
      return this.state();
    }
    this.#phase = "stopping";
    this.#emit();
    await this.#terminateConnector(child);
    this.#flushConnectorLog(generation);
    await new Promise<void>((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      const timer = setTimeout(resolveClose, 3_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
    if (this.#child === child) {
      this.#child = null;
    }
    this.#healthUrl = null;
    this.#phase = this.#executablePath === null ? "unavailable" : "stopped";
    this.#errorMessage = null;
    await this.#removeAttemptFiles(healthUrlFile, pidFile);
    await rm(this.#healthUrlFile, { force: true }).catch(() => undefined);
    this.#emit();
    return this.state();
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.#runtimeApiKey = null;
    this.#controlPlaneProxyUrl = null;
    await rm(this.#attemptDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  async #startAttempt(options: SecureTunnelStartOptions): Promise<SecureTunnelState> {
    if (
      this.#child !== null &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    ) {
      const healthUrlFile = this.#activeHealthUrlFile;
      if (healthUrlFile !== null) {
        this.#startHealthMonitor(
          this.#attemptGeneration,
          this.#child,
          healthUrlFile,
          this.#attemptStartedAtMs,
        );
        await this.#probeReadiness(
          this.#attemptGeneration,
          this.#child,
          healthUrlFile,
          this.#attemptStartedAtMs,
        );
      }
      this.#emit();
      return this.state();
    }
    this.#refreshExecutable();
    if (this.#executablePath === null) {
      this.#phase = "unavailable";
      this.#errorMessage =
        "OpenAI tunnel-client was not found. Install the official Windows binary or set SCR_TUNNEL_CLIENT_PATH before launching Sovereign.";
      this.#emit();
      throw new Error(this.#errorMessage);
    }
    if (
      this.#executableSha256 === null ||
      this.#trustedExecutableSha256 === null ||
      this.#executableSha256 !== this.#trustedExecutableSha256
    ) {
      this.#phase = "error";
      this.#errorMessage = "The resolved tunnel-client executable has not been trusted or its SHA-256 has changed.";
      this.#emit();
      throw new Error(this.#errorMessage);
    }
    if (this.#tunnelId === null) {
      this.#phase = "error";
      this.#errorMessage = "Configure a Secure MCP Tunnel ID before starting the tunnel.";
      this.#emit();
      throw new Error(this.#errorMessage);
    }
    if (this.#runtimeApiKey === null) {
      this.#phase = "error";
      this.#errorMessage = "Enter a tunnel runtime API key before starting the tunnel.";
      this.#emit();
      throw new Error(this.#errorMessage);
    }
    const gatewayEndpoint = validateGatewayEndpoint(options.gatewayEndpoint);
    if (options.gatewayBearerToken.length < 16 || /[\r\n\0]/u.test(options.gatewayBearerToken)) {
      this.#phase = "error";
      this.#errorMessage = "The active Sovereign Gateway credential is invalid.";
      this.#emit();
      throw new Error(this.#errorMessage);
    }

    await mkdir(this.#attemptDirectory, { recursive: true });
    await rm(this.#healthUrlFile, { force: true }).catch(() => undefined);
    const attempt = this.#beginAttempt();
    await this.#removeAttemptFiles(attempt.healthUrlFile, attempt.pidFile);
    this.#healthUrl = null;
    this.#errorMessage = null;
    this.#logTail = "";
    this.#connectorLogCarry = "";
    this.#phase = "starting";
    this.#nextReconnectAt = null;
    this.#emit();

    const childEnvironment = sanitizeTunnelChildEnvironment(process.env);
    let child: ChildProcess;
    try {
      child = this.#spawnConnector(this.#executablePath, ["run"], {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...childEnvironment,
          CONTROL_PLANE_API_KEY: this.#runtimeApiKey,
          CONTROL_PLANE_TUNNEL_ID: this.#tunnelId,
          MCP_SERVER_URL: gatewayEndpoint,
          MCP_EXTRA_HEADERS: "Authorization: env:SCR_GATEWAY_AUTH_HEADER",
          MCP_DISCOVERY_EXTRA_HEADERS: "Authorization: env:SCR_GATEWAY_AUTH_HEADER",
          SCR_GATEWAY_AUTH_HEADER: `Bearer ${options.gatewayBearerToken}`,
          ...(this.#controlPlaneProxyUrl === null
            ? {}
            : {
                CONTROL_PLANE_HTTP_PROXY: "env:SCR_TUNNEL_CONTROL_PLANE_PROXY_URL",
                SCR_TUNNEL_CONTROL_PLANE_PROXY_URL: this.#controlPlaneProxyUrl,
              }),
          HEALTH_LISTEN_ADDR: "127.0.0.1:0",
          HEALTH_URL_FILE: attempt.healthUrlFile,
          PID_FILE: attempt.pidFile,
          LOG_LEVEL: "info",
          LOG_FORMAT: "json",
          NO_COLOR: "1",
        },
      });
    } catch (error) {
      await this.#removeAttemptFiles(attempt.healthUrlFile, attempt.pidFile);
      if (this.#attemptGeneration === attempt.generation) {
        this.#activeHealthUrlFile = null;
        this.#activePidFile = null;
        this.#attemptStartedAtMs = 0;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#recordFailureEvidence("spawn", message, attempt.generation);
      this.#phase = "error";
      this.#errorMessage = message;
      this.#scheduleReconnect();
      this.#emit();
      return this.state();
    }

    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.#isCurrentAttempt(attempt.generation, child)) {
        this.#appendConnectorLog(chunk);
        this.#emit();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (this.#isCurrentAttempt(attempt.generation, child)) {
        this.#appendConnectorLog(chunk);
        this.#emit();
      }
    });
    child.once("error", (error) => {
      if (this.#isCurrentAttempt(attempt.generation, child)) {
        this.#recordFailureEvidence("process", error.message, attempt.generation);
        this.#phase = "error";
        this.#errorMessage = error.message;
        this.#emit();
      }
    });
    child.once("close", (exitCode) => {
      this.#handleChildClose(attempt.generation, child, exitCode);
    });
    const deadline = Date.now() + this.#startupReadyTimeoutMs;
    while (
      this.#isCurrentAttempt(attempt.generation, child) &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    ) {
      if (
        await this.#probeReadiness(
          attempt.generation,
          child,
          attempt.healthUrlFile,
          attempt.startedAtMs,
        )
      ) {
        this.#startHealthMonitor(
          attempt.generation,
          child,
          attempt.healthUrlFile,
          attempt.startedAtMs,
        );
        this.#emit();
        return this.state();
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    if (
      this.#isCurrentAttempt(attempt.generation, child) &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      // The short local startup grace is not the control-plane poll deadline.
      // A connector may still be starting or waiting for its first long poll.
      // Preserve actual failure evidence, but never manufacture an HTTP failure
      // just because this bounded start() call needs to return.
      this.#phase = this.#failureDiagnostic === null ? "starting" : "running";
      this.#errorMessage = this.#failureDiagnostic === null ? null :
        "tunnel-client is running but /readyz is not ready yet. It will keep reconnecting; verify the tunnel ID, runtime-key permissions, proxy route, and ChatGPT workspace association.";
      this.#startHealthMonitor(
        attempt.generation,
        child,
        attempt.healthUrlFile,
        attempt.startedAtMs,
      );
      this.#emit();
    }
    return this.state();
  }

  #handleChildClose(
    generation: number,
    child: ChildProcess,
    exitCode: number | null,
  ): void {
    if (!this.#isCurrentAttempt(generation, child)) {
      return;
    }
    const intentional = this.#phase === "stopping" || !this.#desiredRunning;
    const healthUrlFile = this.#activeHealthUrlFile;
    const pidFile = this.#activePidFile;
    this.#flushConnectorLog(generation);
    if (!intentional) {
      this.#recordFailureEvidence(
        "process",
        exitCode === 0
          ? "Connector process exited while continuous availability was desired."
          : `Connector process exited with code ${exitCode ?? -1}.`,
        generation,
      );
    }
    this.#child = null;
    this.#healthUrl = null;
    this.#activeHealthUrlFile = null;
    this.#activePidFile = null;
    this.#attemptStartedAtMs = 0;
    this.#stopHealthMonitor();
    this.#markReadinessUnstable();
    void this.#removeAttemptFiles(healthUrlFile, pidFile);
    if (intentional) {
      this.#phase = this.#executablePath === null ? "unavailable" : "stopped";
      this.#errorMessage = null;
      this.#emit();
      return;
    }
    this.#phase = "error";
    this.#errorMessage = exitCode === 0
      ? "tunnel-client exited while Remote Host desired it to remain online."
      : `tunnel-client exited with code ${exitCode ?? -1}.`;
    if (this.#autoReconnect) {
      this.#scheduleReconnect();
    } else {
      this.#desiredRunning = false;
      this.#lastStartOptions = null;
    }
    this.#emit();
  }

  #requiresLocalAction(): boolean {
    return ["auth", "identity"].includes(this.#failureDiagnostic?.failureClass ?? "");
  }

  #readinessFailureCanRecycle(): boolean {
    const diagnostic = this.#failureDiagnostic;
    return diagnostic === null ||
      !["auth", "identity", "local-mcp"].includes(diagnostic.failureClass);
  }

  #requestAttemptRecycle(generation: number, reason: string): void {
    if (
      this.#requiresLocalAction() ||
      !this.#autoReconnect ||
      !this.#desiredRunning ||
      this.#lastStartOptions === null ||
      this.#recycleGeneration !== null ||
      generation !== this.#attemptGeneration
    ) {
      return;
    }
    const child = this.#child;
    if (
      child === null ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      this.#scheduleReconnect();
      return;
    }
    this.#markReadinessUnstable();
    this.#recycleGeneration = generation;
    void this.#recycleCurrentAttempt(generation, child, reason).catch((error: unknown) => {
      if (this.#recycleGeneration === generation) {
        this.#recycleGeneration = null;
      }
      if (!this.#desiredRunning || !this.#autoReconnect || this.#lastStartOptions === null) {
        return;
      }
      this.#phase = "error";
      this.#errorMessage =
        `${reason} Connector recycle failed: ${error instanceof Error ? error.message : String(error)}`;
      this.#scheduleReconnect();
      this.#emit();
    });
  }

  async #recycleCurrentAttempt(
    generation: number,
    child: ChildProcess,
    reason: string,
  ): Promise<void> {
    if (!this.#isCurrentAttempt(generation, child)) {
      if (this.#recycleGeneration === generation) {
        this.#recycleGeneration = null;
      }
      return;
    }
    const healthUrlFile = this.#activeHealthUrlFile;
    const pidFile = this.#activePidFile;
    this.#flushConnectorLog(generation);
    this.#stopHealthMonitor();
    this.#markReadinessUnstable();
    this.#phase = "error";
    this.#errorMessage = reason;
    this.#emit();

    this.#invalidateAttempt();
    this.#child = null;
    this.#consecutiveReadinessFailures = 0;
    await this.#terminateConnector(child);
    await this.#removeAttemptFiles(healthUrlFile, pidFile);

    if (this.#recycleGeneration === generation) {
      this.#recycleGeneration = null;
    }
    if (this.#desiredRunning && this.#autoReconnect && this.#lastStartOptions !== null) {
      this.#scheduleReconnect();
    }
    this.#emit();
  }

  async #restartForNetworkChange(): Promise<SecureTunnelState> {
    const options = this.#lastStartOptions;
    if (
      this.#requiresLocalAction() ||
      options === null ||
      !this.#desiredRunning ||
      !this.#autoReconnect
    ) {
      return this.state();
    }
    const child = this.#child;
    const healthUrlFile = this.#activeHealthUrlFile;
    const pidFile = this.#activePidFile;
    const generation = this.#attemptGeneration;
    this.#cancelReconnectTimer();
    this.#stopHealthMonitor();
    this.#markReadinessUnstable();
    this.#phase = "error";
    this.#errorMessage = "Network path changed; rebuilding Secure MCP Tunnel now.";
    // A changed network path invalidates the old backoff: the next attempt runs
    // against a different route, so the ladder starts over.
    this.#reconnectAttempt = 1;
    this.#emit();

    if (child !== null && child.exitCode === null && child.signalCode === null) {
      this.#invalidateAttempt();
      this.#child = null;
      this.#consecutiveReadinessFailures = 0;
      await this.#terminateConnector(child);
      this.#flushConnectorLog(generation);
    } else {
      this.#child = null;
      this.#invalidateAttempt();
    }
    await this.#removeAttemptFiles(healthUrlFile, pidFile);
    this.#recycleGeneration = null;
    return await this.#startAttempt(options);
  }

  #scheduleReconnect(delayOverride?: number): void {
    if (
      this.#requiresLocalAction() ||
      !this.#autoReconnect ||
      !this.#desiredRunning ||
      this.#lastStartOptions === null ||
      this.#reconnectTimer !== null
    ) {
      return;
    }
    this.#reconnectAttempt += 1;
    const delay = delayOverride ?? this.#reconnectDelaysMs[
      Math.min(this.#reconnectAttempt - 1, this.#reconnectDelaysMs.length - 1)
    ]!;
    this.#nextReconnectAt = new Date(Date.now() + delay).toISOString();
    const baseMessage = this.#errorMessage ?? "Secure MCP Tunnel is offline.";
    this.#errorMessage = `${baseMessage.replace(/ Retrying in .*$/u, "")} Retrying in ${Math.max(1, Math.ceil(delay / 1_000))}s.`;
    const options = this.#lastStartOptions;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#nextReconnectAt = null;
      if (this.#requiresLocalAction() || !this.#autoReconnect || !this.#desiredRunning || options === null) {
        this.#emit();
        return;
      }
      void this.#startAttempt(options).catch((error: unknown) => {
        this.#phase = "error";
        this.#errorMessage = error instanceof Error ? error.message : String(error);
        this.#scheduleReconnect();
        this.#emit();
      });
    }, delay);
    this.#reconnectTimer.unref();
  }

  #cancelReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#nextReconnectAt = null;
  }

  #cancelReadyStabilityTimer(): void {
    if (this.#readyStabilityTimer !== null) {
      clearTimeout(this.#readyStabilityTimer);
      this.#readyStabilityTimer = null;
    }
  }

  #markReadinessUnstable(): void {
    this.#cancelReadyStabilityTimer();
    this.#readySinceMs = null;
  }

  #armReconnectBackoffReset(generation: number, child: ChildProcess): void {
    if (
      this.#reconnectAttempt === 0 ||
      this.#readySinceMs === null ||
      this.#readyStabilityTimer !== null ||
      !this.#isCurrentAttempt(generation, child)
    ) {
      return;
    }
    const delay = Math.max(
      10,
      this.#reconnectStabilityWindowMs - (Date.now() - this.#readySinceMs),
    );
    this.#readyStabilityTimer = setTimeout(() => {
      this.#readyStabilityTimer = null;
      if (
        !this.#isCurrentAttempt(generation, child) ||
        this.#phase !== "ready" ||
        this.#readySinceMs === null
      ) {
        return;
      }
      const remaining = this.#reconnectStabilityWindowMs - (Date.now() - this.#readySinceMs);
      if (remaining > 0) {
        this.#armReconnectBackoffReset(generation, child);
        return;
      }
      this.#reconnectAttempt = 0;
      this.#nextReconnectAt = null;
      this.#emit();
    }, delay);
    this.#readyStabilityTimer.unref();
  }

  #startHealthMonitor(
    generation: number,
    child: ChildProcess,
    healthUrlFile: string,
    startedAtMs: number,
  ): void {
    this.#stopHealthMonitor();
    this.#healthTimer = setInterval(() => {
      if (
        this.#healthProbeGeneration === generation ||
        !this.#isCurrentAttempt(generation, child) ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        return;
      }
      this.#healthProbeGeneration = generation;
      void this.#probeReadiness(generation, child, healthUrlFile, startedAtMs)
        .then((ready) => {
          if (!this.#isCurrentAttempt(generation, child) || ready === null) {
            return;
          }
          this.#emit();
        })
        .finally(() => {
          if (this.#healthProbeGeneration === generation) {
            this.#healthProbeGeneration = null;
          }
        });
    }, this.#healthProbeIntervalMs);
    this.#healthTimer.unref();
  }

  #stopHealthMonitor(): void {
    if (this.#healthTimer !== null) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = null;
    }
    this.#healthProbeGeneration = null;
  }

  #checkReadinessDeadline(generation: number, startedAtMs: number): void {
    if (this.#hadReadyConnection) {
      if (++this.#consecutiveReadinessFailures < READINESS_FAILURES_BEFORE_RECYCLE) return;
    } else if (Date.now() - startedAtMs <= this.#controlPlanePoll.deadlineMs) return;
    const reason = this.#hadReadyConnection
      ? "The connector lost readiness across consecutive health checks."
      : "The connector did not become locally ready before its startup deadline.";
    this.#recordFailureEvidence("readiness-timeout", reason, generation);
    if (this.#readinessFailureCanRecycle()) this.#requestAttemptRecycle(generation, reason);
  }

  #refreshExecutable(): void {
    this.#executablePath = resolveTunnelClient(
      this.#configuredExecutablePath,
      this.#packagedExecutablePath,
    );
    this.#executableSha256 = null;
    if (this.#executablePath !== null) {
      try {
        this.#executableSha256 = sha256File(this.#executablePath);
      } catch (error) {
        if (this.#child === null || this.#child.exitCode !== null || this.#child.signalCode !== null) {
          this.#phase = "error";
          this.#errorMessage = `Could not hash tunnel-client: ${error instanceof Error ? error.message : String(error)}`;
        }
        return;
      }
    }

    if (this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null) {
      return;
    }
    if (this.#executablePath === null || this.#executableSha256 === null) {
      this.#phase = "unavailable";
      if (!this.#desiredRunning) {
        this.#errorMessage = null;
      }
      return;
    }
    if (
      this.#trustedExecutableSha256 !== null &&
      this.#executableSha256 !== this.#trustedExecutableSha256
    ) {
      this.#phase = "error";
      this.#errorMessage = "The tunnel-client executable changed since it was trusted. Review the path and SHA-256 before starting it again.";
      return;
    }
    if (this.#reconnectTimer === null) {
      this.#phase = "stopped";
    }
    if (this.#errorMessage?.startsWith("The tunnel-client executable changed") === true) {
      this.#errorMessage = null;
    }
  }

  async #probeReadiness(
    generation: number,
    child: ChildProcess,
    healthUrlFile: string,
    startedAtMs: number,
  ): Promise<boolean | null> {
    if (
      !this.#isCurrentAttempt(generation, child) ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return false;
    }
    if (this.#healthUrl === null) {
      try {
        const healthUrl = await readLoopbackHealthUrl(healthUrlFile, startedAtMs);
        if (!this.#isCurrentAttempt(generation, child)) {
          return false;
        }
        this.#healthUrl = healthUrl;
      } catch (error) {
        if (this.#isCurrentAttempt(generation, child)) {
          if (!isMissingFileError(error)) {
            this.#recordFailureEvidence(
              "health-file",
              error instanceof Error ? error.message : String(error),
              generation,
            );
          }
          this.#phase = "starting";
          this.#checkReadinessDeadline(generation, startedAtMs);
        }
        return false;
      }
    }
    const probeStartedAtMs = Date.now();
    const answer = await askConnectorReadiness(this.#healthUrl, this.#localProbeTimeoutMs);
    if (!this.#isCurrentAttempt(generation, child)) {
      return false;
    }
    if (answer.kind === "unanswered") {
      // A saturated host answers late. Only a connector silent for longer than the
      // poll freshness window counts as failed; until then nothing is known to have
      // changed, so the attempt keeps its phase and nothing is recycled.
      const sinceMs = this.#unanswered?.generation === generation ? this.#unanswered.sinceMs : probeStartedAtMs;
      this.#unanswered = { generation, sinceMs };
      if (Date.now() - sinceMs <= this.#controlPlanePoll.freshnessMs) {
        return null;
      }
    } else {
      this.#unanswered = null;
    }
    if (answer.kind === "ready") {
      // /readyz does not cover the control plane, so a route that cannot
      // reach it still answers ready; only a recent poll proves the route.
      const verdict = judgeControlPlanePoll(answer.lastSuccessfulPollMs, startedAtMs, Date.now(), this.#controlPlanePoll);
      if (verdict.ready === null) {
        this.#phase = "starting";
        return false; // Waiting for remote evidence is neither readiness nor a failed route.
      }
      if (!verdict.ready) {
        this.#recordFailureEvidence("control-plane-poll", verdict.detail, generation);
        this.#phase = "running";
        if (this.#readinessFailureCanRecycle()) {
          this.#requestAttemptRecycle(generation, verdict.detail);
        }
        return false;
      }
      const readyAtMs = Date.now();
      if (this.#readySinceMs === null) {
        this.#readySinceMs = readyAtMs;
      }
      this.#hadReadyConnection = true;
      this.#consecutiveReadinessFailures = 0;
      this.#clearFailureDiagnostic();
      this.#phase = "ready";
      this.#errorMessage = null;
      this.#lastReadyAt = new Date(readyAtMs).toISOString();
      this.#nextReconnectAt = null;
      this.#armReconnectBackoffReset(generation, child);
      return true;
    }
    this.#markReadinessUnstable();
    if (answer.kind === "not-ready") {
      this.#recordFailureEvidence(
        "readyz",
        answer.body.trim().length === 0 ? `HTTP ${answer.statusCode}` : answer.body,
        generation,
        answer.statusCode,
      );
    } else {
      this.#recordFailureEvidence("health-probe", answer.detail, generation, answer.kind === "failed" ? answer.statusCode : undefined);
    }
    this.#phase = "running";
    this.#checkReadinessDeadline(generation, startedAtMs);
    return false;
  }

  #emit(): void {
    this.#onStateChanged?.();
  }
}
