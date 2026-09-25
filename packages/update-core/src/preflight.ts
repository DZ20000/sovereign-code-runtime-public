import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  inspectCandidateSlot,
  type CandidateSlotInspection,
} from "./candidate-slot.js";
import type { TrustedReleasePublicKey } from "./manifest.js";

export const CANDIDATE_PREFLIGHT_SCHEMA_VERSION =
  "scr.candidate-preflight/v1" as const;
export const UPDATE_PREFLIGHT_EVIDENCE_SCHEMA_VERSION =
  "scr.update-preflight-evidence/v1" as const;

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;
const MAX_PREFLIGHT_TIMEOUT_MS = 120_000;
const MAX_PREFLIGHT_REPORT_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SAFE_ENVIRONMENT_NAMES = new Set([
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "WINDIR",
]);

export type CandidatePreflightErrorCode =
  | "INVALID_INPUT"
  | "SLOT_VERIFICATION_FAILED"
  | "ENTRYPOINT_UNSAFE"
  | "LAUNCH_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "REPORT_MISSING"
  | "REPORT_INVALID"
  | "CANDIDATE_FAILED"
  | "CLEANUP_FAILED";

export class CandidatePreflightError extends Error {
  readonly code: CandidatePreflightErrorCode;
  readonly checks: CandidatePreflightChecks | undefined;

  constructor(
    code: CandidatePreflightErrorCode,
    message: string,
    options: ErrorOptions & { readonly checks?: CandidatePreflightChecks } = {},
  ) {
    super(message, options);
    this.name = "CandidatePreflightError";
    this.code = code;
    this.checks = options.checks;
  }
}

export interface CandidatePreflightProcessRequest {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface CandidatePreflightProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface CandidatePreflightProcessLauncher {
  readonly launch: (
    request: CandidatePreflightProcessRequest,
  ) => Promise<CandidatePreflightProcessExit>;
}

export interface RunCandidatePreflightInput {
  readonly slotsDirectory: string;
  readonly releaseId: string;
  readonly trustedKeys: readonly TrustedReleasePublicKey[];
  readonly isolatedRootDirectory: string;
  readonly timeoutMs?: number;
  readonly requireDirectorySync?: boolean;
  readonly retainArtifacts?: boolean;
  readonly signal?: AbortSignal;
  readonly launcher?: CandidatePreflightProcessLauncher;
}

export interface CandidatePreflightChecks {
  readonly slotReinspectionMatched: boolean;
  readonly directorySyncSatisfied: boolean;
  readonly processExit: boolean;
  readonly reportOk: boolean;
  readonly preflightErrorAbsent: boolean;
  readonly identityMatched: boolean;
  readonly executableMatched: boolean;
  readonly runtimeProtocolMatched: boolean;
  readonly runtimeVersionMatched: boolean;
  readonly runtimeRunning: boolean;
  readonly loopbackEndpoint: boolean;
  readonly toolsLoaded: boolean;
  readonly shellObserved: boolean;
  readonly runtimeHostObserved: boolean;
  readonly hostGuardianObserved: boolean;
  readonly realMemoryObserved: boolean;
  readonly availabilityObserved: boolean;
  readonly uiReady: boolean;
  readonly tunnelIsolated: boolean;
}

export interface CandidatePreflightResult {
  readonly schemaVersion: typeof CANDIDATE_PREFLIGHT_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: CandidateSlotInspection["channel"];
  readonly manifestSha256: string;
  readonly slotPath: string;
  readonly executablePath: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reportSha256: string;
  readonly reportBytes: number;
  readonly checks: CandidatePreflightChecks;
  readonly artifactsDirectory: string | null;
}

interface ParsedPreflightEvidence {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly manifestSha256: string;
  readonly executablePath: string;
  readonly runtimeHostProtocolVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(
  value: unknown,
  maximumCharacters: number,
): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumCharacters &&
    !/[\0\r\n]/u.test(value);
}

function comparablePath(value: string): string {
  const normalized = resolve(value)
    .replace(/^\\\\\?\\/u, "")
    .replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function assertContained(rootPath: string, candidatePath: string): void {
  const contained = relative(rootPath, candidatePath);
  if (
    contained === "" ||
    contained === ".." ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new CandidatePreflightError(
      "ENTRYPOINT_UNSAFE",
      "Candidate preflight path escapes its verified release slot.",
    );
  }
}

async function ensureRealDirectory(
  directoryPath: string,
  label: string,
): Promise<string> {
  const localWindowsPath = process.platform !== "win32" ||
    (
      /^[A-Za-z]:[\\/]/u.test(directoryPath) &&
      !directoryPath.startsWith("\\\\") &&
      !directoryPath.startsWith("\\?\\") &&
      !directoryPath.startsWith("\\.\\")
    );
  if (
    typeof directoryPath !== "string" ||
    !isAbsolute(directoryPath) ||
    !localWindowsPath ||
    directoryPath.length === 0 ||
    directoryPath.length > 4_096 ||
    directoryPath.includes("\0")
  ) {
    throw new CandidatePreflightError(
      "INVALID_INPUT",
      `${label} must be a bounded absolute local path.`,
    );
  }
  const absolutePath = resolve(directoryPath);
  const info = await lstat(absolutePath).catch((error: unknown) => {
    throw new CandidatePreflightError(
      "INVALID_INPUT",
      `${label} is unavailable.`,
      { cause: error },
    );
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CandidatePreflightError(
      "INVALID_INPUT",
      `${label} must be a real directory.`,
    );
  }
  const resolvedPath = await realpath(absolutePath);
  if (!samePath(absolutePath, resolvedPath)) {
    throw new CandidatePreflightError(
      "INVALID_INPUT",
      `${label} may not traverse a symbolic link or junction.`,
    );
  }
  return resolvedPath;
}

async function resolveVerifiedEntrypoint(
  inspection: CandidateSlotInspection,
): Promise<string> {
  const slotRoot = await ensureRealDirectory(
    inspection.slotPath,
    "Candidate release slot",
  );
  const executablePath = resolve(
    slotRoot,
    ...inspection.entrypoint.split("/"),
  );
  assertContained(slotRoot, executablePath);
  const pathInfo = await lstat(executablePath).catch((error: unknown) => {
    throw new CandidatePreflightError(
      "ENTRYPOINT_UNSAFE",
      "Candidate preflight entrypoint is unavailable.",
      { cause: error },
    );
  });
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    pathInfo.nlink > 1
  ) {
    throw new CandidatePreflightError(
      "ENTRYPOINT_UNSAFE",
      "Candidate preflight entrypoint must be one unshared regular file.",
    );
  }
  const resolvedEntrypoint = await realpath(executablePath);
  if (!samePath(executablePath, resolvedEntrypoint)) {
    throw new CandidatePreflightError(
      "ENTRYPOINT_UNSAFE",
      "Candidate preflight entrypoint may not traverse a symbolic link or junction.",
    );
  }
  assertContained(slotRoot, resolvedEntrypoint);
  return executablePath;
}

function validateTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAX_PREFLIGHT_TIMEOUT_MS
  ) {
    throw new CandidatePreflightError(
      "INVALID_INPUT",
      `Candidate preflight timeout must be from 1000 through ${MAX_PREFLIGHT_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeoutMs;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  if (left.dev === 0 || left.ino === 0 || right.dev === 0 || right.ino === 0) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function safeBaseEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase()) &&
      value.length <= 32_768 &&
      !value.includes("\0")
    ) {
      output[name] = value;
    }
  }
  return output;
}

async function createIsolatedEnvironment(
  parentDirectory: string,
  inspection: CandidateSlotInspection,
): Promise<{
  readonly root: string;
  readonly reportPath: string;
  readonly environment: Readonly<Record<string, string>>;
}> {
  const root = await mkdtemp(join(parentDirectory, "candidate-preflight-"));
  const profile = join(root, "profile");
  const roaming = join(profile, "Roaming");
  const local = join(profile, "Local");
  const userData = join(root, "user-data");
  const workspace = join(root, "workspace");
  const temporary = join(root, "temp");
  const webview = join(root, "webview2");
  await Promise.all([
    mkdir(roaming, { recursive: true }),
    mkdir(local, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(temporary, { recursive: true }),
    mkdir(webview, { recursive: true }),
  ]);
  const reportPath = join(root, "candidate-smoke-report.json");
  return {
    root,
    reportPath,
    environment: {
      ...safeBaseEnvironment(),
      APPDATA: roaming,
      HOME: profile,
      LOCALAPPDATA: local,
      TEMP: temporary,
      TMP: temporary,
      USERPROFILE: profile,
      WEBVIEW2_USER_DATA_FOLDER: webview,
      SCR_RUN_COMPLETION_NOTIFICATIONS: "0",
      SCR_SMOKE_REPORT_PATH: reportPath,
      SCR_UPDATE_PREFLIGHT: "1",
      SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256: inspection.manifestSha256,
      SCR_UPDATE_PREFLIGHT_RELEASE_ID: inspection.releaseId,
      SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE: String(inspection.releaseSequence),
      SCR_USER_DATA_PATH: userData,
      SCR_WORKSPACE_ROOT: workspace,
    },
  };
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    return;
  }
  child.kill("SIGKILL");
}

export const nodeCandidatePreflightLauncher: CandidatePreflightProcessLauncher = {
  async launch(request): Promise<CandidatePreflightProcessExit> {
    if (request.signal?.aborted === true) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
      };
    }
    let child: ChildProcess;
    try {
      child = spawn(request.executablePath, [...request.arguments], {
        cwd: request.cwd,
        env: { ...request.environment },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      throw new CandidatePreflightError(
        "LAUNCH_FAILED",
        "Candidate preflight process could not be created.",
        { cause: error },
      );
    }

    let timedOut = false;
    let cancelled = false;
    let terminationStarted = false;
    const terminate = async (reason: "timeout" | "cancelled"): Promise<void> => {
      if (terminationStarted) return;
      terminationStarted = true;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      await terminateProcessTree(child);
    };
    const abortHandler = (): void => {
      void terminate("cancelled");
    };
    request.signal?.addEventListener("abort", abortHandler, { once: true });
    const timer = setTimeout(() => {
      void terminate("timeout");
    }, request.timeoutMs);

    try {
      return await new Promise<CandidatePreflightProcessExit>((resolveExit, rejectExit) => {
        child.once("error", (error) => {
          rejectExit(new CandidatePreflightError(
            "LAUNCH_FAILED",
            "Candidate preflight process failed to start.",
            { cause: error },
          ));
        });
        child.once("close", (exitCode, signal) => {
          resolveExit({ exitCode, signal, timedOut, cancelled });
        });
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortHandler);
    }
  },
};

async function readBoundedReport(reportPath: string): Promise<Buffer> {
  const pathInfo = await lstat(reportPath).catch((error: unknown) => {
    throw new CandidatePreflightError(
      "REPORT_MISSING",
      "Candidate preflight did not publish its smoke report.",
      { cause: error },
    );
  });
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    pathInfo.nlink > 1 ||
    pathInfo.size < 1 ||
    pathInfo.size > MAX_PREFLIGHT_REPORT_BYTES
  ) {
    throw new CandidatePreflightError(
      "REPORT_INVALID",
      "Candidate preflight report is not a bounded unshared regular file.",
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(reportPath, "r");
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.nlink > 1 ||
      !sameFileIdentity(pathInfo, openedInfo) ||
      openedInfo.size !== pathInfo.size
    ) {
      throw new CandidatePreflightError(
        "REPORT_INVALID",
        "Candidate preflight report changed while it was being opened.",
      );
    }
    const bytes = await handle.readFile();
    const finalInfo = await handle.stat();
    if (
      bytes.byteLength !== openedInfo.size ||
      finalInfo.size !== openedInfo.size ||
      finalInfo.mtimeMs !== openedInfo.mtimeMs ||
      finalInfo.ctimeMs !== openedInfo.ctimeMs ||
      !sameFileIdentity(openedInfo, finalInfo)
    ) {
      throw new CandidatePreflightError(
        "REPORT_INVALID",
        "Candidate preflight report changed while it was being verified.",
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof CandidatePreflightError) throw error;
    throw new CandidatePreflightError(
      "REPORT_INVALID",
      "Candidate preflight report could not be read safely.",
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parsePreflightEvidence(value: unknown): ParsedPreflightEvidence {
  if (!isRecord(value)) {
    throw new CandidatePreflightError(
      "REPORT_INVALID",
      "Candidate preflight identity evidence is missing.",
    );
  }
  const expectedKeys = new Set([
    "schemaVersion",
    "releaseId",
    "releaseSequence",
    "manifestSha256",
    "executablePath",
    "runtimeHostProtocolVersion",
  ]);
  if (
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    [...expectedKeys].some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== UPDATE_PREFLIGHT_EVIDENCE_SCHEMA_VERSION ||
    typeof value.releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(value.releaseId) ||
    typeof value.releaseSequence !== "number" ||
    !Number.isSafeInteger(value.releaseSequence) ||
    value.releaseSequence < 1 ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    !boundedString(value.executablePath, 4_096) ||
    typeof value.runtimeHostProtocolVersion !== "number" ||
    !Number.isSafeInteger(value.runtimeHostProtocolVersion) ||
    value.runtimeHostProtocolVersion < 1
  ) {
    throw new CandidatePreflightError(
      "REPORT_INVALID",
      "Candidate preflight identity evidence is malformed.",
    );
  }
  return {
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence,
    manifestSha256: value.manifestSha256,
    executablePath: value.executablePath,
    runtimeHostProtocolVersion: value.runtimeHostProtocolVersion,
  };
}

function loopbackMcpEndpoint(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
      url.pathname === "/mcp" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0;
  } catch {
    return false;
  }
}

function evaluateReport(
  value: unknown,
  inspection: CandidateSlotInspection,
  executablePath: string,
  exit: CandidatePreflightProcessExit,
  requireDirectorySync: boolean,
  slotReinspectionMatched: boolean,
): CandidatePreflightChecks {
  if (!isRecord(value) || value.schemaVersion !== "scr.tauri-smoke/v1") {
    throw new CandidatePreflightError(
      "REPORT_INVALID",
      "Candidate preflight report uses an unsupported schema.",
    );
  }
  const evidence = parsePreflightEvidence(value.updatePreflight);
  const state = isRecord(value.state) ? value.state : {};
  const manifest = isRecord(value.manifest) ? value.manifest : {};
  const resources = isRecord(value.resources) ? value.resources : {};
  const totals = isRecord(resources.totals) ? resources.totals : {};
  const availability = isRecord(value.availability) ? value.availability : {};
  const ui = isRecord(value.ui) ? value.ui : {};
  const secureTunnel = isRecord(state.secureTunnel) ? state.secureTunnel : {};
  const processes = Array.isArray(resources.processes)
    ? resources.processes.filter(isRecord)
    : [];
  const roles = new Set(processes.flatMap((process) =>
    typeof process.role === "string" ? [process.role] : []
  ));
  const toolCount = state.toolCount;
  const manifestTools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const href = ui.href;
  const title = ui.title;
  const readyState = ui.readyState;
  const appChildCount = ui.appChildCount;
  return {
    slotReinspectionMatched,
    directorySyncSatisfied:
      !requireDirectorySync || inspection.directorySyncCompleted,
    processExit: exit.exitCode === 0 && exit.signal === null,
    reportOk: value.ok === true,
    preflightErrorAbsent: value.updatePreflightError === null,
    identityMatched:
      evidence.releaseId === inspection.releaseId &&
      evidence.releaseSequence === inspection.releaseSequence &&
      evidence.manifestSha256 === inspection.manifestSha256,
    executableMatched: samePath(evidence.executablePath, executablePath),
    runtimeProtocolMatched:
      evidence.runtimeHostProtocolVersion ===
      inspection.compatibility.runtimeHostProtocolVersion,
    runtimeVersionMatched:
      state.runtimeVersion === inspection.version &&
      manifest.runtimeVersion === inspection.version,
    runtimeRunning: state.phase === "running",
    loopbackEndpoint: loopbackMcpEndpoint(state.endpoint),
    toolsLoaded:
      Number.isSafeInteger(toolCount) &&
      typeof toolCount === "number" &&
      toolCount > 0 &&
      toolCount <= 4_096 &&
      manifestTools.length === toolCount,
    shellObserved: roles.has("desktop-main"),
    runtimeHostObserved: roles.has("runtime-host"),
    hostGuardianObserved: roles.has("host-guardian"),
    realMemoryObserved:
      typeof totals.productPrivateBytes === "number" &&
      Number.isFinite(totals.productPrivateBytes) &&
      totals.productPrivateBytes > 0,
    availabilityObserved:
      availability.schemaVersion === "scr.host-availability/v1" &&
      availability.available === true &&
      typeof availability.sampledAt === "string" &&
      Number.isFinite(availability.systemUptimeMs) &&
      typeof availability.systemUptimeMs === "number" &&
      availability.systemUptimeMs > 0,
    uiReady:
      value.uiReady === true &&
      typeof href === "string" &&
      /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)\//u.test(href) &&
      title === "Sovereign Code Runtime" &&
      (readyState === "interactive" || readyState === "complete") &&
      Number.isSafeInteger(appChildCount) &&
      typeof appChildCount === "number" &&
      appChildCount > 0,
    tunnelIsolated:
      secureTunnel.desiredRunning === false &&
      secureTunnel.processId === null &&
      secureTunnel.hasRuntimeApiKey === false &&
      secureTunnel.tunnelId === null,
  };
}

function dataSchemaCompatibilityMatches(
  left: CandidateSlotInspection["compatibility"]["dataSchemas"]["settings"],
  right: CandidateSlotInspection["compatibility"]["dataSchemas"]["settings"],
): boolean {
  return left.readableMin === right.readableMin &&
    left.readableMax === right.readableMax &&
    left.writeVersion === right.writeVersion;
}

function compatibilityMatches(
  left: CandidateSlotInspection["compatibility"],
  right: CandidateSlotInspection["compatibility"],
): boolean {
  return left.minimumBootstrapVersion === right.minimumBootstrapVersion &&
    left.maximumBootstrapVersion === right.maximumBootstrapVersion &&
    left.runtimeHostProtocolVersion === right.runtimeHostProtocolVersion &&
    left.preCommitDataPolicy === right.preCommitDataPolicy &&
    dataSchemaCompatibilityMatches(left.dataSchemas.settings, right.dataSchemas.settings) &&
    dataSchemaCompatibilityMatches(left.dataSchemas.audit, right.dataSchemas.audit) &&
    dataSchemaCompatibilityMatches(left.dataSchemas.runs, right.dataSchemas.runs);
}

function inspectionsMatch(
  left: CandidateSlotInspection,
  right: CandidateSlotInspection,
): boolean {
  return left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.version === right.version &&
    left.channel === right.channel &&
    left.createdAt === right.createdAt &&
    left.entrypoint === right.entrypoint &&
    left.manifestSha256 === right.manifestSha256 &&
    left.envelopeSha256 === right.envelopeSha256 &&
    left.signingKeyId === right.signingKeyId &&
    left.componentCount === right.componentCount &&
    left.totalBytes === right.totalBytes &&
    compatibilityMatches(left.compatibility, right.compatibility) &&
    samePath(left.slotPath, right.slotPath);
}

export async function runCandidatePreflight(
  input: RunCandidatePreflightInput,
): Promise<CandidatePreflightResult> {
  if (
    typeof input.releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(input.releaseId)
  ) {
    throw new CandidatePreflightError(
      "INVALID_INPUT",
      "Candidate preflight release ID has an invalid shape.",
    );
  }
  const timeoutMs = validateTimeout(input.timeoutMs);
  const isolatedParent = await ensureRealDirectory(
    input.isolatedRootDirectory,
    "Candidate preflight isolated root directory",
  );
  if (signalIsAborted(input.signal)) {
    throw new CandidatePreflightError(
      "CANCELLED",
      "Candidate preflight was cancelled before slot verification.",
    );
  }

  let initialInspection: CandidateSlotInspection;
  try {
    initialInspection = await inspectCandidateSlot({
      slotsDirectory: input.slotsDirectory,
      releaseId: input.releaseId,
      trustedKeys: input.trustedKeys,
    });
  } catch (error) {
    throw new CandidatePreflightError(
      "SLOT_VERIFICATION_FAILED",
      "Candidate release slot failed verification before preflight.",
      { cause: error },
    );
  }

  const isolated = await createIsolatedEnvironment(
    isolatedParent,
    initialInspection,
  );
  const retainArtifacts = input.retainArtifacts === true;
  let cleanupError: unknown;
  let operationError: unknown;
  try {
    let inspection: CandidateSlotInspection;
    try {
      inspection = await inspectCandidateSlot({
        slotsDirectory: input.slotsDirectory,
        releaseId: input.releaseId,
        trustedKeys: input.trustedKeys,
      });
    } catch (error) {
      throw new CandidatePreflightError(
        "SLOT_VERIFICATION_FAILED",
        "Candidate release slot failed its immediate preflight reinspection.",
        { cause: error },
      );
    }
    const slotReinspectionMatched = inspectionsMatch(
      initialInspection,
      inspection,
    );
    if (!slotReinspectionMatched) {
      throw new CandidatePreflightError(
        "SLOT_VERIFICATION_FAILED",
        "Candidate release identity changed between preflight inspections.",
      );
    }
    if (input.requireDirectorySync === true && !inspection.directorySyncCompleted) {
      throw new CandidatePreflightError(
        "SLOT_VERIFICATION_FAILED",
        "Candidate slot directory durability is insufficient for this preflight policy.",
      );
    }

    let launchInspection: CandidateSlotInspection;
    try {
      launchInspection = await inspectCandidateSlot({
        slotsDirectory: input.slotsDirectory,
        releaseId: input.releaseId,
        trustedKeys: input.trustedKeys,
      });
    } catch (error) {
      throw new CandidatePreflightError(
        "SLOT_VERIFICATION_FAILED",
        "Candidate release slot failed its final pre-launch inspection.",
        { cause: error },
      );
    }
    if (!inspectionsMatch(inspection, launchInspection)) {
      throw new CandidatePreflightError(
        "SLOT_VERIFICATION_FAILED",
        "Candidate release identity changed immediately before preflight launch.",
      );
    }
    if (
      input.requireDirectorySync === true &&
      !launchInspection.directorySyncCompleted
    ) {
      throw new CandidatePreflightError(
        "SLOT_VERIFICATION_FAILED",
        "Candidate slot directory durability changed before preflight launch.",
      );
    }
    const executablePath = await resolveVerifiedEntrypoint(launchInspection);
    const startedAtDate = new Date();
    let exit: CandidatePreflightProcessExit;
    try {
      exit = await (input.launcher ?? nodeCandidatePreflightLauncher).launch({
        executablePath,
        arguments: [],
        cwd: launchInspection.slotPath,
        environment: isolated.environment,
        timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (error instanceof CandidatePreflightError) throw error;
      throw new CandidatePreflightError(
        "LAUNCH_FAILED",
        "Candidate preflight launcher failed.",
        { cause: error },
      );
    }
    if (exit.cancelled || signalIsAborted(input.signal)) {
      throw new CandidatePreflightError(
        "CANCELLED",
        "Candidate preflight was cancelled.",
      );
    }
    if (exit.timedOut) {
      throw new CandidatePreflightError(
        "TIMEOUT",
        "Candidate preflight exceeded its bounded deadline.",
      );
    }

    const reportBytes = await readBoundedReport(isolated.reportPath);
    let reportValue: unknown;
    try {
      reportValue = JSON.parse(reportBytes.toString("utf8"));
    } catch (error) {
      throw new CandidatePreflightError(
        "REPORT_INVALID",
        "Candidate preflight report is not valid JSON.",
        { cause: error },
      );
    }
    const checks = evaluateReport(
      reportValue,
      launchInspection,
      executablePath,
      exit,
      input.requireDirectorySync === true,
      slotReinspectionMatched,
    );
    if (!Object.values(checks).every(Boolean)) {
      throw new CandidatePreflightError(
        "CANDIDATE_FAILED",
        "Candidate preflight evidence did not satisfy every required check.",
        { checks },
      );
    }
    const completedAtDate = new Date();
    return {
      schemaVersion: CANDIDATE_PREFLIGHT_SCHEMA_VERSION,
      releaseId: launchInspection.releaseId,
      releaseSequence: launchInspection.releaseSequence,
      version: launchInspection.version,
      channel: launchInspection.channel,
      manifestSha256: launchInspection.manifestSha256,
      slotPath: launchInspection.slotPath,
      executablePath,
      startedAt: startedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      durationMs: Math.max(0, completedAtDate.getTime() - startedAtDate.getTime()),
      exitCode: exit.exitCode,
      signal: exit.signal,
      reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
      reportBytes: reportBytes.byteLength,
      checks,
      artifactsDirectory: retainArtifacts ? isolated.root : null,
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (!retainArtifacts) {
      try {
        await rm(isolated.root, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 100,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError !== undefined) {
      if (operationError instanceof CandidatePreflightError) {
        throw new CandidatePreflightError(
          operationError.code,
          operationError.message,
          {
            cause: new AggregateError(
              [operationError, cleanupError],
              "Candidate preflight failed and isolated artifact cleanup also failed.",
            ),
            ...(operationError.checks === undefined
              ? {}
              : { checks: operationError.checks }),
          },
        );
      }
      if (operationError !== undefined) {
        throw new CandidatePreflightError(
          "CLEANUP_FAILED",
          "Candidate preflight failed and isolated artifacts could not be removed.",
          {
            cause: new AggregateError(
              [operationError, cleanupError],
              "Candidate preflight and cleanup both failed.",
            ),
          },
        );
      }
      throw new CandidatePreflightError(
        "CLEANUP_FAILED",
        "Candidate preflight isolated artifacts could not be removed.",
        { cause: cleanupError },
      );
    }
  }
}