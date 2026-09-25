import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { win32 } from "node:path";

import {
  type AuditOutcome,
  type AuditReceipt,
  type AuditStore,
  type Capability,
  MemoryRunStore,
  type Principal,
  PolicyEngine,
  type RunRecord,
  type RunStore,
  type RunSummary,
  RuntimeError,
  RUNTIME_BUILD_SOURCE,
  assertSha256,
  equalSha256,
  sha256,
  summarizeRun,
} from "@sovereign/runtime-core";

import { ManagedBrowserManager, type BrowserObservation, type BrowserSessionSummary } from "./browser-manager.js";
import { ConPtySessionManager, type TerminalSessionRecord } from "./conpty-manager.js";
import { NativeComputerManager, type ComputerAction, type ComputerObservation } from "./computer-manager.js";
import { discoverPythonRuntime, type PythonRuntimeSpec } from "./python-runtime.js";
import { ManagedRunManager } from "./run-manager.js";
import { BoundedOutputBuffer, outputRetention, runOutputRange, type OutputRetention } from "./output-buffer.js";
import { validationProcess } from "./validation-process.js";
import { sanitizedChildEnvironment } from "./process-environment.js";
import {
  followRunSnapshot,
  runFollowHasDelta,
  type RunFollowResult,
} from "./run-follow.js";
import {
  buildWorkspaceContext,
  type WorkspaceContextResult,
} from "./workspace-context.js";
import {
  NativeNotificationManager,
  type DesktopNotificationInput,
  type DesktopNotificationResult,
} from "./notification-manager.js";
import {
  RunCompletionNotifier,
  type RunCompletionNotifierOptions,
} from "./run-completion-notifier.js";

import { WindowsPathGuard, normalizeWindowsRelativePath, type WorkspaceDefinition } from "./path-guard.js";
export * from "./path-guard.js";
export * from "./python-runtime.js";
export * from "./browser-manager.js";
export * from "./computer-manager.js";
export * from "./conpty-manager.js";
export * from "./notification-manager.js";
export * from "./run-completion-notifier.js";
export * from "./run-follow.js";
export * from "./workspace-context.js";

const SEARCHABLE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const EXCLUDED_SEARCH_DIRECTORIES = new Set([".git", ".scr", "coverage", "dist", "node_modules"]);

export interface WorkspaceEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory" | "file" | "symlink" | "other";
}

export interface WorkspaceTreeEntry extends WorkspaceEntry {
  readonly depth: number;
}

export interface FileMetadataResult {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly type: "directory" | "file";
  readonly bytes: number;
  readonly modifiedAt: string;
  readonly sha256?: string;
}

export interface ReadTextResult {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly content: string;
}

export interface WriteTextResult {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly receiptId: string;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
}

export type OwnedRuntimeProcessRole = "managed-run" | "terminal" | "browser";

export interface OwnedRuntimeProcess {
  readonly processId: number;
  readonly role: OwnedRuntimeProcessRole;
  readonly label: string;
}

export interface ProcessResult {
  readonly outputRetention?: OutputRetention;
  readonly commandLabel: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface TerminalExecutionResult extends ProcessResult {
  readonly workspaceId: string;
  readonly relativeCwd: string;
  readonly receiptId: string;
}

export interface PythonRuntimeCapabilities {
  readonly available: boolean;
  readonly launcher: string | null;
  readonly version: string | null;
  readonly implementation: string | null;
  readonly isolatedMode: true;
  readonly networkIsolation: false;
}


export type WorkflowStep =
  | { readonly kind: "validation"; readonly task: "typecheck" | "test" | "build" }
  | { readonly kind: "terminal"; readonly command: string }
  | { readonly kind: "python"; readonly code: string };

export type ComputerActionInput =
  | { readonly operation: "focus_window"; readonly windowId: string }
  | { readonly operation: "click"; readonly x: number; readonly y: number }
  | { readonly operation: "type_text"; readonly text: string }
  | { readonly operation: "press_key"; readonly key: string }
  | { readonly operation: "launch_application"; readonly path: string };

export interface WindowsAdapterOptions {
  readonly workspaces: readonly WorkspaceDefinition[];
  readonly policy: PolicyEngine;
  readonly audit: AuditStore;
  readonly runStore?: RunStore;
  readonly nativeAgentPath?: string;
  readonly notificationManager?: NativeNotificationManager;
  readonly runCompletionNotifierOptions?: RunCompletionNotifierOptions;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly processTimeoutMs?: number;
  readonly maxProcessOutputBytes?: number;
}

function codeOf(error: unknown): string {
  return error instanceof RuntimeError ? error.code : "INTERNAL_ERROR";
}

function outcomeOf(error: unknown): AuditOutcome {
  return error instanceof RuntimeError && error.code === "POLICY_DENIED" ? "denied" : "failed";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizeGitRevision(input: string): string {
  const value = input.trim();
  if (
    value.length === 0 ||
    value.length > 200 ||
    value.includes("\0") ||
    !/^[A-Za-z0-9@][A-Za-z0-9._/@{}^~+-]{0,199}$/u.test(value)
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Git revision must be a bounded commit-ish without whitespace, path selectors, or option prefixes.",
      400,
    );
  }
  return value;
}

interface OutputCollector {
  readonly append: (chunk: Buffer) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
}

function createOutputCollector(maxBytes: number): OutputCollector {
  const chunks: Buffer[] = [];
  let acceptedBytes = 0;
  let wasTruncated = false;

  return {
    append(chunk): void {
      const remaining = maxBytes - acceptedBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        chunks.push(accepted);
        acceptedBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining) {
        wasTruncated = true;
      }
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    truncated(): boolean {
      return wasTruncated;
    },
  };
}

// Repository configuration is workspace content, so it is attacker-controlled
// whenever an agent can write the tree. These overrides keep a checkout from
// turning an ordinary Git read into command execution.
const GIT_CONTAINMENT_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=NUL",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "core.sshCommand=",
];

async function runGit(
  args: readonly string[],
  cwd: string,
  commandLabel: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ProcessResult> {
  return await runBoundedProcess(
    "git",
    [...GIT_CONTAINMENT_ARGS, ...args],
    cwd,
    commandLabel,
    timeoutMs,
    maxOutputBytes,
  );
}

async function runBoundedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  commandLabel: string,
  timeoutMs: number,
  maxOutputBytes: number,
  windowsVerbatimArguments = false,
  retainOutputTail = false,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  // Parsed Git/probe stdout retains its original prefix semantics. Human-facing
  // commands opt into a tail so final errors remain visible after log floods.
  const tailStdout = retainOutputTail ? new BoundedOutputBuffer(maxOutputBytes) : null;
  const tailStderr = retainOutputTail ? new BoundedOutputBuffer(maxOutputBytes) : null;
  const stdout = tailStdout ?? createOutputCollector(maxOutputBytes);
  const stderr = tailStderr ?? createOutputCollector(maxOutputBytes);

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...sanitizedChildEnvironment(), NO_COLOR: "1", NoDefaultCurrentDirectoryInExePath: "1" },
      shell: false,
      windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => {
          child.kill();
        });
        killer.once("close", (exitCode) => {
          if (exitCode !== 0) {
            child.kill();
          }
        });
      } else {
        child.kill();
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new RuntimeError("PROCESS_FAILED", `${commandLabel} could not be started.`, 500, {
          cause: error.message,
        }),
      );
    });

    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new RuntimeError("PROCESS_TIMEOUT", `${commandLabel} exceeded its time limit.`, 408, {
            timeoutMs,
          }),
        );
        return;
      }
      tailStdout?.finish();
      tailStderr?.finish();
      resolve({
        ...(tailStdout === null || tailStderr === null ? {} : { outputRetention: outputRetention(tailStdout, tailStderr) }),
        commandLabel,
        exitCode: exitCode ?? -1,
        signal,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
        outputTruncated: stdout.truncated() || stderr.truncated(),
      });
    });
  });
}

function boundedDiagnostic(value: string): string {
  return value.length <= 16_384 ? value : `${value.slice(0, 16_383)}…`;
}

function assertSuccessfulProcess(result: ProcessResult, operation: string): ProcessResult {
  if (result.exitCode === 0) {
    return result;
  }
  throw new RuntimeError("PROCESS_FAILED", `${operation} exited with code ${result.exitCode}.`, 409, {
    exitCode: result.exitCode,
    stdout: boundedDiagnostic(result.stdout),
    stderr: boundedDiagnostic(result.stderr),
    outputTruncated: result.outputTruncated,
  });
}

export class WindowsAdapter {
  readonly #policy: PolicyEngine;
  readonly #audit: AuditStore;
  readonly #guards = new Map<string, WindowsPathGuard>();
  readonly #browserWorkspaces = new Map<string, string>();
  readonly #maxReadBytes: number;
  readonly #maxWriteBytes: number;
  readonly #processTimeoutMs: number;
  readonly #maxProcessOutputBytes: number;
  readonly #runs: ManagedRunManager;
  readonly #terminals: ConPtySessionManager;
  readonly #browser: ManagedBrowserManager;
  readonly #computer: NativeComputerManager;
  readonly #notifications: NativeNotificationManager;
  readonly #runCompletionNotifier: RunCompletionNotifier;
  #pythonRuntimePromise: Promise<PythonRuntimeSpec | null> | undefined;

  constructor(options: WindowsAdapterOptions) {
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#maxReadBytes = options.maxReadBytes ?? 262_144;
    this.#maxWriteBytes = options.maxWriteBytes ?? 1_048_576;
    this.#processTimeoutMs = options.processTimeoutMs ?? 120_000;
    this.#maxProcessOutputBytes = options.maxProcessOutputBytes ?? 1_048_576;
    this.#notifications =
      options.notificationManager ?? new NativeNotificationManager(options.nativeAgentPath);
    this.#runCompletionNotifier = new RunCompletionNotifier(
      this.#notifications,
      this.#audit,
      options.runCompletionNotifierOptions,
    );
    this.#runs = new ManagedRunManager(
      options.runStore ?? new MemoryRunStore(),
      this.#maxProcessOutputBytes,
      async (run) => {
        await this.#runCompletionNotifier.handle(run);
      },
    );
    this.#terminals = new ConPtySessionManager(
      options.nativeAgentPath,
      this.#maxProcessOutputBytes,
    );
    this.#browser = new ManagedBrowserManager();
    this.#computer = new NativeComputerManager(options.nativeAgentPath);
    for (const workspace of options.workspaces) {
      if (this.#guards.has(workspace.id)) {
        throw new RuntimeError("INTERNAL_ERROR", `Duplicate workspace id: ${workspace.id}`, 500);
      }
      this.#guards.set(workspace.id, new WindowsPathGuard(workspace));
    }
  }

  async registerWorkspace(workspace: WorkspaceDefinition): Promise<string> {
    if (workspace.id.length === 0 || workspace.id.length > 128 || workspace.id.trim() !== workspace.id) {
      throw new RuntimeError("INVALID_INPUT", "A bounded workspace id is required.", 400);
    }
    const guard = new WindowsPathGuard(workspace);
    const root = await guard.realRoot();
    const existing = this.#guards.get(workspace.id);
    if (existing !== undefined) {
      const previousRoot = await existing.realRoot();
      if (previousRoot.toLocaleLowerCase("en-US") !== root.toLocaleLowerCase("en-US")) {
        throw new RuntimeError("POLICY_DENIED", "A registered workspace cannot be assigned a different root.", 403);
      }
      return previousRoot;
    }
    this.#guards.set(workspace.id, guard);
    return root;
  }

  terminalSessionWorkspaceId(sessionId: string): string | null {
    return this.#terminals.get(sessionId)?.workspaceId ?? null;
  }

  browserSessionWorkspaceId(sessionId: string): string | null {
    return this.#browserWorkspaces.get(sessionId) ?? null;
  }

  #requireBrowserWorkspace(workspaceId: string, sessionId: string): void {
    if (this.#browserWorkspaces.get(sessionId) !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The browser session was not found in this workspace.", 404);
    }
  }

  #guard(workspaceId: string): WindowsPathGuard {
    const guard = this.#guards.get(workspaceId);
    if (guard === undefined) {
      throw new RuntimeError("WORKSPACE_NOT_FOUND", `Unknown workspace: ${workspaceId}`, 404);
    }
    return guard;
  }

  async #pythonRuntime(cwd: string): Promise<PythonRuntimeSpec | null> {
    this.#pythonRuntimePromise ??= discoverPythonRuntime(cwd, this.#maxProcessOutputBytes, runBoundedProcess);
    return this.#pythonRuntimePromise;
  }

  #require(
    principal: Principal,
    workspaceId: string | undefined,
    capabilities: readonly Capability[],
  ): void {
    this.#policy.require(principal, capabilities, workspaceId);
  }

  #appendWriteReceipt(input: {
    readonly id: string;
    readonly principal: Principal;
    readonly toolName: string;
    readonly operation: string;
    readonly outcome: AuditOutcome;
    readonly workspaceId: string;
    readonly requestedPath: string;
    readonly relativePath?: string;
    readonly beforeSha256?: string;
    readonly afterSha256?: string;
    readonly errorCode?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): void {
    const receipt: AuditReceipt = {
      id: input.id,
      occurredAt: new Date().toISOString(),
      principalId: input.principal.id,
      toolName: input.toolName,
      operation: input.operation,
      outcome: input.outcome,
      workspaceId: input.workspaceId,
      details: {
        requestedPath: input.requestedPath,
        ...(input.details ?? {}),
      },
      ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
      ...(input.beforeSha256 === undefined ? {} : { beforeSha256: input.beforeSha256 }),
      ...(input.afterSha256 === undefined ? {} : { afterSha256: input.afterSha256 }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    };
    this.#audit.append(receipt);
  }

  systemInfo(principal: Principal): Readonly<Record<string, unknown>> {
    this.#policy.require(principal, ["system.read"]);
    return {
      platform: platform(),
      release: release(),
      architecture: arch(),
      nodeVersion: process.version,
      runtimeBuildSource: RUNTIME_BUILD_SOURCE,
      processId: process.pid,
      conPtyAvailable: this.#terminals.available(),
      managedBrowserAvailable: this.#browser.available(),
      computerUseAvailable: this.#computer.available(),
      notificationsAvailable: this.#notifications.available(),
    };
  }

  async notifyDesktop(
    principal: Principal,
    input: DesktopNotificationInput,
  ): Promise<DesktopNotificationResult & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    const titleSha256 = sha256(input.title);
    const messageSha256 = sha256(input.message);
    try {
      this.#policy.require(principal, ["system.notify"]);
      const result = await this.#notifications.notify(input);
      this.#audit.append({
        id: receiptId,
        occurredAt: new Date().toISOString(),
        principalId: principal.id,
        toolName: "system.notify",
        operation: "show_windows_notification",
        outcome: "succeeded",
        details: {
          titleSha256,
          messageSha256,
          titleCharacters: input.title.length,
          messageCharacters: input.message.length,
          severity: result.severity,
          durationMs: result.durationMs,
          acceptedAt: result.acceptedAt,
          mechanism: result.mechanism,
        },
      });
      return { ...result, receiptId };
    } catch (error) {
      this.#audit.append({
        id: receiptId,
        occurredAt: new Date().toISOString(),
        principalId: principal.id,
        toolName: "system.notify",
        operation: "show_windows_notification",
        outcome: outcomeOf(error),
        errorCode: codeOf(error),
        details: {
          titleSha256,
          messageSha256,
          titleCharacters: input.title.length,
          messageCharacters: input.message.length,
          severity: input.severity ?? "info",
          durationMs: input.durationMs ?? 6_000,
        },
      });
      throw error;
    }
  }

  async listWorkspace(
    principal: Principal,
    workspaceId: string,
    relativePath = "",
  ): Promise<readonly WorkspaceEntry[]> {
    this.#require(principal, workspaceId, ["workspace.read"]);
    const resolved = await this.#guard(workspaceId).resolve(relativePath, "read", true);
    const info = await lstat(resolved.absolutePath);
    if (!info.isDirectory()) {
      throw new RuntimeError("PATH_NOT_DIRECTORY", "The requested workspace path is not a directory.", 400);
    }

    const entries = await readdir(resolved.absolutePath, { withFileTypes: true });
    return entries
      .map((entry: Dirent): WorkspaceEntry => ({
        name: entry.name,
        path:
          resolved.relativePath.length === 0
            ? entry.name
            : win32.join(resolved.relativePath, entry.name),
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async workspaceTree(
    principal: Principal,
    workspaceId: string,
    relativePath = "",
    maxDepth = 3,
    maxEntries = 200,
  ): Promise<readonly WorkspaceTreeEntry[]> {
    this.#require(principal, workspaceId, ["workspace.read"]);
    const boundedDepth = Math.max(1, Math.min(maxDepth, 4));
    const boundedEntries = Math.max(1, Math.min(maxEntries, 500));
    const queue: Array<{ readonly path: string; readonly depth: number }> = [
      { path: relativePath, depth: 0 },
    ];
    const result: WorkspaceTreeEntry[] = [];

    while (queue.length > 0 && result.length < boundedEntries) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      const entries = await this.listWorkspace(principal, workspaceId, current.path);
      for (const entry of entries) {
        if (entry.name.toLowerCase() === ".git") continue;
        if (result.length >= boundedEntries) {
          break;
        }
        const depth = current.depth + 1;
        result.push({ ...entry, depth });
        if (entry.type === "directory" && depth < boundedDepth) {
          queue.push({ path: entry.path, depth });
        }
      }
    }

    return result;
  }

  async fileMetadata(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
  ): Promise<FileMetadataResult> {
    this.#require(principal, workspaceId, ["files.read"]);
    const resolved = await this.#guard(workspaceId).resolve(relativePath, "read");
    const info = await lstat(resolved.absolutePath);
    if (info.isDirectory()) {
      return {
        workspaceId,
        relativePath: resolved.relativePath,
        type: "directory",
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new RuntimeError("FILE_NOT_REGULAR", "Only single-link regular files and directories have metadata.", 400);
    }

    let digest: string | undefined;
    if (info.size <= this.#maxReadBytes) {
      const handle = await open(resolved.absolutePath, "r");
      try {
        await this.#guard(workspaceId).assertOpenedRegularFile(resolved.absolutePath, handle);
        digest = sha256(await handle.readFile());
      } finally {
        await handle.close();
      }
    }
    return {
      workspaceId,
      relativePath: resolved.relativePath,
      type: "file",
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      ...(digest === undefined ? {} : { sha256: digest }),
    };
  }

  async readTextFile(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
    maxBytes = this.#maxReadBytes,
  ): Promise<ReadTextResult> {
    this.#require(principal, workspaceId, ["files.read"]);
    const resolved = await this.#guard(workspaceId).resolve(relativePath, "read");
    const handle = await open(resolved.absolutePath, "r");
    try {
      await this.#guard(workspaceId).assertOpenedRegularFile(resolved.absolutePath, handle);
      const info = await handle.stat();
      const boundedMax = Math.max(1, Math.min(maxBytes, this.#maxReadBytes));
      if (info.size > boundedMax) {
        throw new RuntimeError("FILE_TOO_LARGE", "The file exceeds the configured read limit.", 413, {
          bytes: info.size,
          maxBytes: boundedMax,
        });
      }
      const data = await handle.readFile();
      return {
        workspaceId,
        relativePath: resolved.relativePath,
        bytes: data.byteLength,
        sha256: sha256(data),
        content: data.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }

  async createTextFile(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
    content: string,
  ): Promise<WriteTextResult> {
    const receiptId = randomUUID();
    let normalizedPath: string | undefined;
    try {
      this.#require(principal, workspaceId, ["files.write"]);
      const data = Buffer.from(content, "utf8");
      if (data.byteLength > this.#maxWriteBytes) {
        throw new RuntimeError("FILE_TOO_LARGE", "The new file exceeds the configured write limit.", 413);
      }
      const resolved = await this.#guard(workspaceId).resolve(relativePath, "create");
      normalizedPath = resolved.relativePath;
      const handle = await open(resolved.absolutePath, "wx");
      try {
        // Opening may create an empty file if an authorized directory is raced
        // into a junction. Content is written only after the opened handle is
        // proven to be the single-link file at the contained canonical path.
        await this.#guard(workspaceId).assertOpenedRegularFile(resolved.absolutePath, handle);
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const afterSha256 = sha256(data);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.create",
        operation: "create_text_file",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativePath,
        relativePath: resolved.relativePath,
        afterSha256,
        details: { bytes: data.byteLength },
      });
      return {
        workspaceId,
        relativePath: resolved.relativePath,
        bytes: data.byteLength,
        sha256: afterSha256,
        receiptId,
      };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.create",
        operation: "create_text_file",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativePath,
        ...(normalizedPath === undefined ? {} : { relativePath: normalizedPath }),
        errorCode: codeOf(error),
      });
      throw error;
    }
  }

  async createDirectory(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
  ): Promise<{ readonly workspaceId: string; readonly relativePath: string; readonly receiptId: string }> {
    const receiptId = randomUUID();
    let normalizedPath: string | undefined;
    try {
      this.#require(principal, workspaceId, ["files.write"]);
      const resolved = await this.#guard(workspaceId).resolve(relativePath, "create");
      normalizedPath = resolved.relativePath;
      await mkdir(resolved.absolutePath);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.mkdir",
        operation: "create_directory",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativePath,
        relativePath: resolved.relativePath,
      });
      return {
        workspaceId,
        relativePath: resolved.relativePath,
        receiptId,
      };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.mkdir",
        operation: "create_directory",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativePath,
        ...(normalizedPath === undefined ? {} : { relativePath: normalizedPath }),
        errorCode: codeOf(error),
      });
      throw error;
    }
  }

  async replaceTextFile(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
    content: string,
    expectedSha256: string,
    receiptToolName = "files.replace",
    receiptOperation = "replace_text_file",
  ): Promise<WriteTextResult> {
    const receiptId = randomUUID();
    let normalizedPath: string | undefined;
    let beforeSha256: string | undefined;
    try {
      this.#require(principal, workspaceId, ["files.write"]);
      assertSha256(expectedSha256);
      const nextData = Buffer.from(content, "utf8");
      if (nextData.byteLength > this.#maxWriteBytes) {
        throw new RuntimeError("FILE_TOO_LARGE", "The replacement exceeds the configured write limit.", 413);
      }
      const resolved = await this.#guard(workspaceId).resolve(relativePath, "read");
      normalizedPath = resolved.relativePath;
      const handle = await open(resolved.absolutePath, "r+");
      try {
        await this.#guard(workspaceId).assertOpenedRegularFile(resolved.absolutePath, handle);
        const info = await handle.stat();
        if (info.size > this.#maxReadBytes) {
          throw new RuntimeError("FILE_TOO_LARGE", "The current file exceeds the guarded-read limit.", 413);
        }
        const currentData = await handle.readFile();
        beforeSha256 = sha256(currentData);
        if (!equalSha256(beforeSha256, expectedSha256)) {
          throw new RuntimeError("STALE_HASH", "The file changed after it was read.", 409, {
            expectedSha256,
            actualSha256: beforeSha256,
          });
        }
        if (nextData.byteLength > 0) {
          await handle.write(nextData, 0, nextData.byteLength, 0);
        }
        await handle.truncate(nextData.byteLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const afterSha256 = sha256(nextData);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: receiptToolName,
        operation: receiptOperation,
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativePath,
        relativePath: resolved.relativePath,
        beforeSha256,
        afterSha256,
        details: { bytes: nextData.byteLength },
      });
      return {
        workspaceId,
        relativePath: resolved.relativePath,
        bytes: nextData.byteLength,
        sha256: afterSha256,
        receiptId,
      };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: receiptToolName,
        operation: receiptOperation,
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativePath,
        ...(normalizedPath === undefined ? {} : { relativePath: normalizedPath }),
        ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
        errorCode: codeOf(error),
      });
      throw error;
    }
  }

  async replaceTextInFile(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
    findText: string,
    replacementText: string,
    expectedSha256: string,
    occurrence: "first" | "all" = "first",
  ): Promise<WriteTextResult & { readonly replacements: number }> {
    if (findText.length === 0) {
      throw new RuntimeError("INVALID_INPUT", "findText must not be empty.", 400);
    }
    assertSha256(expectedSha256);
    const current = await this.readTextFile(principal, workspaceId, relativePath);
    if (!equalSha256(current.sha256, expectedSha256)) {
      throw new RuntimeError("STALE_HASH", "The file changed after it was read.", 409, {
        expectedSha256,
        actualSha256: current.sha256,
      });
    }

    const matches = current.content.split(findText).length - 1;
    if (matches === 0) {
      throw new RuntimeError("INVALID_INPUT", "findText was not found in the current file.", 400);
    }
    const replacements = occurrence === "all" ? matches : 1;
    const nextContent =
      occurrence === "all"
        ? current.content.split(findText).join(replacementText)
        : current.content.replace(findText, replacementText);
    const result = await this.replaceTextFile(
      principal,
      workspaceId,
      relativePath,
      nextContent,
      expectedSha256,
      "files.replace_text",
      "replace_text_in_file",
    );
    return { ...result, replacements };
  }

  async moveFile(
    principal: Principal,
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    expectedSha256: string,
  ): Promise<{
    readonly workspaceId: string;
    readonly sourcePath: string;
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly receiptId: string;
  }> {
    const receiptId = randomUUID();
    let normalizedSource: string | undefined;
    let normalizedDestination: string | undefined;
    let beforeSha256: string | undefined;
    try {
      this.#require(principal, workspaceId, ["files.write"]);
      assertSha256(expectedSha256);
      const source = await this.#guard(workspaceId).resolve(sourcePath, "read");
      const destination = await this.#guard(workspaceId).resolve(destinationPath, "create");
      normalizedSource = source.relativePath;
      normalizedDestination = destination.relativePath;
      const handle = await open(source.absolutePath, "r");
      let bytes = 0;
      try {
        await this.#guard(workspaceId).assertOpenedRegularFile(source.absolutePath, handle);
        const info = await handle.stat();
        if (info.size > this.#maxReadBytes) {
          throw new RuntimeError("FILE_TOO_LARGE", "The source exceeds the guarded-read limit.", 413);
        }
        const data = await handle.readFile();
        bytes = data.byteLength;
        beforeSha256 = sha256(data);
        if (!equalSha256(beforeSha256, expectedSha256)) {
          throw new RuntimeError("STALE_HASH", "The source changed after it was read.", 409, {
            expectedSha256,
            actualSha256: beforeSha256,
          });
        }
      } finally {
        await handle.close();
      }

      await rename(source.absolutePath, destination.absolutePath);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.move",
        operation: "move_file",
        outcome: "succeeded",
        workspaceId,
        requestedPath: sourcePath,
        relativePath: destination.relativePath,
        beforeSha256,
        afterSha256: beforeSha256,
        details: {
          sourcePath: source.relativePath,
          destinationPath: destination.relativePath,
          bytes,
        },
      });
      return {
        workspaceId,
        sourcePath: source.relativePath,
        relativePath: destination.relativePath,
        bytes,
        sha256: beforeSha256,
        receiptId,
      };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.move",
        operation: "move_file",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: sourcePath,
        ...(normalizedDestination === undefined ? {} : { relativePath: normalizedDestination }),
        ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
        errorCode: codeOf(error),
        details: {
          ...(normalizedSource === undefined ? {} : { sourcePath: normalizedSource }),
          destinationPath,
        },
      });
      throw error;
    }
  }

  async deleteFile(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
    expectedSha256: string,
  ): Promise<{
    readonly workspaceId: string;
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly receiptId: string;
  }> {
    const receiptId = randomUUID();
    let normalizedPath: string | undefined;
    let beforeSha256: string | undefined;
    let bytes = 0;
    try {
      this.#require(principal, workspaceId, ["files.write", "files.destructive"]);
      assertSha256(expectedSha256);
      const resolved = await this.#guard(workspaceId).resolve(relativePath, "read");
      normalizedPath = resolved.relativePath;
      const handle = await open(resolved.absolutePath, "r");
      try {
        await this.#guard(workspaceId).assertOpenedRegularFile(resolved.absolutePath, handle);
        const info = await handle.stat();
        if (info.size > this.#maxReadBytes) {
          throw new RuntimeError("FILE_TOO_LARGE", "The file exceeds the guarded-read limit.", 413);
        }
        const data = await handle.readFile();
        bytes = data.byteLength;
        beforeSha256 = sha256(data);
        if (!equalSha256(beforeSha256, expectedSha256)) {
          throw new RuntimeError("STALE_HASH", "The file changed after it was read.", 409, {
            expectedSha256,
            actualSha256: beforeSha256,
          });
        }
      } finally {
        await handle.close();
      }

      await unlink(resolved.absolutePath);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.delete",
        operation: "delete_file",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativePath,
        relativePath: resolved.relativePath,
        beforeSha256,
        details: { bytes },
      });
      return {
        workspaceId,
        relativePath: resolved.relativePath,
        bytes,
        sha256: beforeSha256,
        receiptId,
      };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "files.delete",
        operation: "delete_file",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativePath,
        ...(normalizedPath === undefined ? {} : { relativePath: normalizedPath }),
        ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
        errorCode: codeOf(error),
      });
      throw error;
    }
  }

  async searchText(
    principal: Principal,
    workspaceId: string,
    query: string,
    relativePath = "",
    maxResults = 50,
  ): Promise<readonly SearchMatch[]> {
    this.#require(principal, workspaceId, ["search.read"]);
    const normalizedQuery = query.toLocaleLowerCase("en-US");
    if (normalizedQuery.length === 0 || normalizedQuery.length > 1_000) {
      throw new RuntimeError("INVALID_INPUT", "Search query length must be between 1 and 1000.", 400);
    }
    const boundedResults = Math.max(1, Math.min(maxResults, 200));
    const start = await this.#guard(workspaceId).resolve(relativePath, "read", true);
    const startInfo = await lstat(start.absolutePath);
    if (!startInfo.isDirectory()) {
      throw new RuntimeError("PATH_NOT_DIRECTORY", "Search root must be a directory.", 400);
    }

    const queue: Array<{ absolutePath: string; relativePath: string }> = [
      { absolutePath: start.absolutePath, relativePath: start.relativePath },
    ];
    const matches: SearchMatch[] = [];
    let visitedFiles = 0;

    while (queue.length > 0 && matches.length < boundedResults && visitedFiles < 5_000) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      const entries = await readdir(current.absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= boundedResults || visitedFiles >= 5_000) {
          break;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        const childRelative =
          current.relativePath.length === 0
            ? entry.name
            : win32.join(current.relativePath, entry.name);
        const childAbsolute = win32.join(current.absolutePath, entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_SEARCH_DIRECTORIES.has(entry.name.toLocaleLowerCase("en-US"))) {
            queue.push({ absolutePath: childAbsolute, relativePath: childRelative });
          }
          continue;
        }
        if (!entry.isFile() || !SEARCHABLE_EXTENSIONS.has(win32.extname(entry.name).toLocaleLowerCase("en-US"))) {
          continue;
        }
        visitedFiles += 1;
        try {
          const handle = await open(childAbsolute, "r");
          let data: Buffer;
          try {
            await this.#guard(workspaceId).assertOpenedRegularFile(childAbsolute, handle);
            const info = await handle.stat();
            if (!info.isFile() || info.size > this.#maxReadBytes) {
              continue;
            }
            data = await handle.readFile();
          } finally {
            await handle.close();
          }
          const lines = data.toString("utf8").split(/\r?\n/u);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex] ?? "";
            const column = line.toLocaleLowerCase("en-US").indexOf(normalizedQuery);
            if (column >= 0) {
              matches.push({
                path: childRelative,
                line: lineIndex + 1,
                column: column + 1,
                snippet: line.length > 300 ? `${line.slice(0, 297)}...` : line,
              });
              if (matches.length >= boundedResults) {
                break;
              }
            }
          }
        } catch (error) {
          if (!isNodeError(error) || !["EACCES", "EPERM", "ENOENT"].includes(error.code ?? "")) {
            throw error;
          }
        }
      }
    }

    return matches;
  }

  async workspaceContext(
    principal: Principal,
    workspaceId: string,
    relativePath = "",
    query?: string,
    cursor?: string,
    maxFiles = 80,
    maxMatches = 20,
    snippetLines = 1,
    maxBytes = 65_536,
    includeUntracked = true,
  ): Promise<WorkspaceContextResult> {
    this.#require(principal, workspaceId, [
      "workspace.read",
      "files.read",
      "search.read",
      "git.read",
    ]);
    const scopePath = relativePath.length === 0
      ? ""
      : normalizeWindowsRelativePath(relativePath).replaceAll("\\", "/");
    return await buildWorkspaceContext({
      workspaceId,
      scopePath,
      ...(query === undefined ? {} : { query }),
      ...(cursor === undefined ? {} : { cursor }),
      maxFiles,
      maxMatches,
      snippetLines,
      maxBytes,
      includeUntracked,
      gitStatus: () => this.gitStatus(principal, workspaceId),
      gitFiles: () => this.gitFiles(
        principal,
        workspaceId,
        scopePath.length === 0 ? undefined : scopePath,
        includeUntracked,
      ),
      readText: (path, readMaxBytes) =>
        this.readTextFile(principal, workspaceId, path, readMaxBytes),
    });
  }

  async runTerminalCommand(
    principal: Principal,
    workspaceId: string,
    command: string,
    relativeCwd = "",
    timeoutMs = this.#processTimeoutMs,
  ): Promise<TerminalExecutionResult> {
    const receiptId = randomUUID();
    const commandDigest = sha256(command);
    let normalizedCwd: string | undefined;
    try {
      this.#require(principal, workspaceId, ["terminal.run"]);
      const normalizedCommand = command.trim();
      if (normalizedCommand.length === 0 || command.length > 32_768 || command.includes("\0")) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "PowerShell command length must be from 1 through 32768 characters and contain no NUL bytes.",
          400,
        );
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
        throw new RuntimeError("INVALID_INPUT", "Terminal timeout must be from 1000 through 300000 milliseconds.", 400);
      }

      const resolved = await this.#guard(workspaceId).resolve(relativeCwd, "read", true);
      normalizedCwd = resolved.relativePath;
      const cwdInfo = await lstat(resolved.absolutePath);
      if (!cwdInfo.isDirectory()) {
        throw new RuntimeError("PATH_NOT_DIRECTORY", "Terminal working directory must be a directory.", 400);
      }

      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const powershell = win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = [
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
        normalizedCommand,
      ].join(" ");
      const result = await runBoundedProcess(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        resolved.absolutePath,
        "PowerShell command",
        timeoutMs,
        this.#maxProcessOutputBytes,
        false,
        true,
      );

      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.exec",
        operation: "execute_powershell",
        outcome: result.exitCode === 0 ? "succeeded" : "failed",
        workspaceId,
        requestedPath: relativeCwd,
        relativePath: resolved.relativePath,
        details: {
          commandSha256: commandDigest,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          outputTruncated: result.outputTruncated,
        },
      });
      return {
        ...result,
        workspaceId,
        relativeCwd: resolved.relativePath,
        receiptId,
      };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.exec",
        operation: "execute_powershell",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativeCwd,
        ...(normalizedCwd === undefined ? {} : { relativePath: normalizedCwd }),
        errorCode: codeOf(error),
        details: { commandSha256: commandDigest },
      });
      throw error;
    }
  }

  async startTerminalRun(
    principal: Principal,
    workspaceId: string,
    command: string,
    relativeCwd = "",
    timeoutMs = this.#processTimeoutMs,
  ): Promise<RunRecord> {
    const receiptId = randomUUID();
    const commandDigest = sha256(command);
    let normalizedCwd: string | undefined;
    try {
      this.#require(principal, workspaceId, ["terminal.run"]);
      const normalizedCommand = command.trim();
      if (normalizedCommand.length === 0 || command.length > 32_768 || command.includes("\0")) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "PowerShell command length must be from 1 through 32768 characters and contain no NUL bytes.",
          400,
        );
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
        throw new RuntimeError("INVALID_INPUT", "Terminal timeout must be from 1000 through 300000 milliseconds.", 400);
      }

      const resolved = await this.#guard(workspaceId).resolve(relativeCwd, "read", true);
      normalizedCwd = resolved.relativePath;
      const cwdInfo = await lstat(resolved.absolutePath);
      if (!cwdInfo.isDirectory()) {
        throw new RuntimeError("PATH_NOT_DIRECTORY", "Terminal working directory must be a directory.", 400);
      }

      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const powershell = win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = [
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
        normalizedCommand,
      ].join(" ");
      const run = this.#runs.start({
        kind: "terminal",
        label: "PowerShell command",
        workspaceId,
        command: powershell,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        cwd: resolved.absolutePath,
        timeoutMs,
        metadata: {
          relativeCwd: resolved.relativePath,
          commandSha256: commandDigest,
          timeoutMs,
        },
      });

      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.start",
        operation: "start_powershell_run",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativeCwd,
        relativePath: resolved.relativePath,
        details: {
          runId: run.id,
          commandSha256: commandDigest,
          timeoutMs,
        },
      });
      return run;
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.start",
        operation: "start_powershell_run",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativeCwd,
        ...(normalizedCwd === undefined ? {} : { relativePath: normalizedCwd }),
        errorCode: codeOf(error),
        details: { commandSha256: commandDigest, timeoutMs },
      });
      throw error;
    }
  }

  async createTerminalSession(
    principal: Principal,
    workspaceId: string,
    relativeCwd = "",
    columns = 120,
    rows = 32,
  ): Promise<TerminalSessionRecord & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    let normalizedCwd: string | undefined;
    try {
      this.#require(principal, workspaceId, ["terminal.run"]);
      const resolved = await this.#guard(workspaceId).resolve(relativeCwd, "read", true);
      normalizedCwd = resolved.relativePath;
      const info = await lstat(resolved.absolutePath);
      if (!info.isDirectory()) {
        throw new RuntimeError("PATH_NOT_DIRECTORY", "Terminal working directory must be a directory.", 400);
      }
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const shellPath = win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const session = this.#terminals.start({
        workspaceId,
        relativeCwd: resolved.relativePath,
        absoluteCwd: resolved.absolutePath,
        shellPath,
        columns,
        rows,
      });
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.create",
        operation: "create_conpty_session",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativeCwd,
        relativePath: resolved.relativePath,
        details: { sessionId: session.id, columns, rows },
      });
      return { ...session, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.create",
        operation: "create_conpty_session",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativeCwd,
        ...(normalizedCwd === undefined ? {} : { relativePath: normalizedCwd }),
        errorCode: codeOf(error),
        details: { columns, rows },
      });
      throw error;
    }
  }

  listTerminalSessions(
    principal: Principal,
    workspaceId: string,
  ): readonly TerminalSessionRecord[] {
    this.#require(principal, workspaceId, ["terminal.observe"]);
    return this.#terminals.list(workspaceId);
  }

  getTerminalSession(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
  ): TerminalSessionRecord {
    this.#require(principal, workspaceId, ["terminal.observe"]);
    const session = this.#terminals.get(sessionId);
    if (session === null || session.workspaceId !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The terminal session was not found.", 404);
    }
    return session;
  }

  writeTerminalSession(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    data: string,
    appendEnter = true,
  ): TerminalSessionRecord & { readonly receiptId: string } {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["terminal.run"]);
      const existing = this.#terminals.get(sessionId);
      if (existing === null || existing.workspaceId !== workspaceId) {
        throw new RuntimeError("RUN_NOT_FOUND", "The terminal session was not found.", 404);
      }
      const session = this.#terminals.write(sessionId, data, appendEnter);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.write",
        operation: "write_conpty_input",
        outcome: "succeeded",
        workspaceId,
        requestedPath: existing.relativeCwd,
        relativePath: existing.relativeCwd,
        details: {
          sessionId,
          inputSha256: sha256(data),
          characters: data.length,
          appendEnter,
        },
      });
      return { ...session, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.write",
        operation: "write_conpty_input",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId, inputSha256: sha256(data), characters: data.length, appendEnter },
      });
      throw error;
    }
  }

  resizeTerminalSession(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    columns: number,
    rows: number,
  ): TerminalSessionRecord & { readonly receiptId: string } {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["terminal.run"]);
      const existing = this.#terminals.get(sessionId);
      if (existing === null || existing.workspaceId !== workspaceId) {
        throw new RuntimeError("RUN_NOT_FOUND", "The terminal session was not found.", 404);
      }
      const session = this.#terminals.resize(sessionId, columns, rows);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.resize",
        operation: "resize_conpty_session",
        outcome: "succeeded",
        workspaceId,
        requestedPath: existing.relativeCwd,
        relativePath: existing.relativeCwd,
        details: { sessionId, columns, rows },
      });
      return { ...session, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.resize",
        operation: "resize_conpty_session",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId, columns, rows },
      });
      throw error;
    }
  }

  closeTerminalSession(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
  ): TerminalSessionRecord & { readonly receiptId: string } {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["terminal.run"]);
      const existing = this.#terminals.get(sessionId);
      if (existing === null || existing.workspaceId !== workspaceId) {
        throw new RuntimeError("RUN_NOT_FOUND", "The terminal session was not found.", 404);
      }
      const session = this.#terminals.close(sessionId);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.close",
        operation: "close_conpty_session",
        outcome: "succeeded",
        workspaceId,
        requestedPath: existing.relativeCwd,
        relativePath: existing.relativeCwd,
        details: { sessionId },
      });
      return { ...session, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "terminal.session.close",
        operation: "close_conpty_session",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId },
      });
      throw error;
    }
  }

  async gitStatus(principal: Principal, workspaceId: string): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    return runGit(
      ["status", "--short", "--branch", "--untracked-files=all"],
      root,
      "git status",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitDiff(
    principal: Principal,
    workspaceId: string,
    relativePath?: string,
    staged = false,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if (staged) {
      args.push("--cached");
    }
    if (relativePath !== undefined) {
      args.push("--", normalizeWindowsRelativePath(relativePath).replaceAll("\\", "/"));
    }
    return runGit(
      args,
      root,
      staged ? "git diff --cached" : "git diff",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitLog(
    principal: Principal,
    workspaceId: string,
    maxCount = 50,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const boundedCount = Math.max(1, Math.min(maxCount, 200));
    return runGit(
      [
        "log",
        "--no-color",
        "--date=iso-strict",
        "--pretty=format:%h%x09%ad%x09%an%x09%s",
        `--max-count=${boundedCount}`,
      ],
      root,
      "git log",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitShow(
    principal: Principal,
    workspaceId: string,
    revision = "HEAD",
    relativePath?: string,
    statOnly = false,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const normalizedRevision = normalizeGitRevision(revision);
    const args = [
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--date=iso-strict",
      "--format=fuller",
      "--stat",
      statOnly ? "--no-patch" : "--patch",
      normalizedRevision,
    ];
    if (relativePath !== undefined) {
      args.push("--", normalizeWindowsRelativePath(relativePath).replaceAll("\\", "/"));
    }
    return runGit(
      args,
      root,
      "git show",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitBlame(
    principal: Principal,
    workspaceId: string,
    relativePath: string,
    startLine = 1,
    lineCount = 200,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    if (
      !Number.isInteger(startLine) || startLine < 1 || startLine > 1_000_000 ||
      !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 2_000
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Git blame line ranges must use a positive start line and from 1 through 2000 lines.",
        400,
      );
    }
    const root = await this.#guard(workspaceId).realRoot();
    const normalizedPath = normalizeWindowsRelativePath(relativePath).replaceAll("\\", "/");
    return runGit(
      ["blame", "--line-porcelain", "-L" + startLine + ",+" + lineCount, "--", normalizedPath],
      root,
      "git blame",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitBranches(
    principal: Principal,
    workspaceId: string,
    maxCount = 100,
    includeRemotes = true,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const boundedCount = Math.max(1, Math.min(maxCount, 500));
    const refs = includeRemotes ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
    return runGit(
      [
        "for-each-ref",
        "--count=" + boundedCount,
        "--sort=-committerdate",
        "--format=%(HEAD)%09%(refname:short)%09%(objectname:short)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)",
        ...refs,
      ],
      root,
      "git branches",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitTags(
    principal: Principal,
    workspaceId: string,
    maxCount = 100,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const boundedCount = Math.max(1, Math.min(maxCount, 500));
    return runGit(
      [
        "for-each-ref",
        "--count=" + boundedCount,
        "--sort=-creatordate",
        "--format=%(refname:short)%09%(objectname:short)%09%(creatordate:iso-strict)%09%(subject)",
        "refs/tags",
      ],
      root,
      "git tags",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitWorktrees(
    principal: Principal,
    workspaceId: string,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    return runGit(
      ["worktree", "list", "--porcelain"],
      root,
      "git worktree list",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitFiles(
    principal: Principal,
    workspaceId: string,
    relativePath?: string,
    includeUntracked = false,
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["git.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const args = includeUntracked
      ? ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"]
      : ["ls-files", "--cached", "--full-name"];
    if (relativePath !== undefined) {
      args.push("--", normalizeWindowsRelativePath(relativePath).replaceAll("\\", "/"));
    }
    return runGit(
      args,
      root,
      includeUntracked ? "git files with untracked" : "git tracked files",
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
    );
  }

  async gitStage(
    principal: Principal,
    workspaceId: string,
    files: readonly string[],
  ): Promise<ProcessResult & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    let normalizedFiles: readonly string[] = [];
    try {
      this.#require(principal, workspaceId, ["git.write"]);
      if (files.length === 0 || files.length > 100) {
        throw new RuntimeError("INVALID_INPUT", "Git stage requires from 1 through 100 paths.", 400);
      }
      normalizedFiles = [...new Set(files.map((file) =>
        normalizeWindowsRelativePath(file).replaceAll("\\", "/")
      ))];
      const root = await this.#guard(workspaceId).realRoot();
      const result = assertSuccessfulProcess(
        await runGit(
          ["add", "--", ...normalizedFiles],
          root,
          "git add",
          this.#processTimeoutMs,
          this.#maxProcessOutputBytes,
        ),
        "git add",
      );
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "git.stage",
        operation: "git_stage",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: { files: normalizedFiles, exitCode: result.exitCode },
      });
      return { ...result, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "git.stage",
        operation: "git_stage",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { files: normalizedFiles },
      });
      throw error;
    }
  }

  async gitCommit(
    principal: Principal,
    workspaceId: string,
    message: string,
  ): Promise<ProcessResult & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    const normalizedMessage = message.trim();
    const messageSha256 = sha256(message);
    try {
      this.#require(principal, workspaceId, ["git.write"]);
      if (normalizedMessage.length === 0 || message.length > 4_000 || message.includes("\0")) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Git commit message length must be from 1 through 4000 characters and contain no NUL bytes.",
          400,
        );
      }
      const root = await this.#guard(workspaceId).realRoot();
      const result = assertSuccessfulProcess(
        await runGit(
          ["-c", "commit.gpgSign=false", "commit", "--no-verify", "-m", normalizedMessage],
          root,
          "git commit",
          this.#processTimeoutMs,
          this.#maxProcessOutputBytes,
        ),
        "git commit",
      );
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "git.commit",
        operation: "git_commit",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: {
          messageSha256,
          exitCode: result.exitCode,
          outputTruncated: result.outputTruncated,
        },
      });
      return { ...result, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "git.commit",
        operation: "git_commit",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { messageSha256 },
      });
      throw error;
    }
  }

  browserCapabilities(principal: Principal): Readonly<Record<string, unknown>> {
    this.#policy.require(principal, ["system.read"]);
    return {
      available: this.#browser.available(),
      engine: "Microsoft Edge CDP",
      sessionIsolation: "temporary-profile",
      domainPolicyRequired: true,
      requestInterception: true,
      semanticElementRefs: true,
      credentialEntry: "human-handoff",
      downloads: false,
      uploads: false,
    };
  }

  async createBrowserSession(
    principal: Principal,
    workspaceId: string,
    allowedDomains: readonly string[],
  ): Promise<BrowserSessionSummary & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["browser.control", "network.access"]);
      this.#guard(workspaceId);
      const session = await this.#browser.create(allowedDomains);
      this.#browserWorkspaces.set(session.id, workspaceId);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.session.create",
        operation: "create_managed_browser_session",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: { sessionId: session.id, allowedDomains: session.allowedDomains },
      });
      return { ...session, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.session.create",
        operation: "create_managed_browser_session",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { allowedDomains },
      });
      throw error;
    }
  }

  listBrowserSessions(
    principal: Principal,
    workspaceId: string,
  ): readonly BrowserSessionSummary[] {
    this.#require(principal, workspaceId, ["browser.observe"]);
    return this.#browser.list().filter((session) => this.#browserWorkspaces.get(session.id) === workspaceId);
  }

  async navigateBrowser(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    url: string,
  ): Promise<BrowserObservation & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["browser.control", "network.access"]);
      this.#requireBrowserWorkspace(workspaceId, sessionId);
      const observation = await this.#browser.navigate(sessionId, url);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.navigate",
        operation: "navigate_managed_browser",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: {
          sessionId,
          targetOrigin: new URL(url).origin,
          resultingUrl: observation.url,
          revision: observation.revision,
        },
      });
      return { ...observation, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.navigate",
        operation: "navigate_managed_browser",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId, urlSha256: sha256(url) },
      });
      throw error;
    }
  }

  async observeBrowser(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    includeScreenshot = false,
  ): Promise<BrowserObservation> {
    this.#require(principal, workspaceId, ["browser.observe"]);
    this.#requireBrowserWorkspace(workspaceId, sessionId);
    return await this.#browser.observe(sessionId, includeScreenshot);
  }

  async clickBrowser(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    expectedRevision: string,
    ref: string,
  ): Promise<BrowserObservation & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["browser.control", "network.access"]);
      this.#requireBrowserWorkspace(workspaceId, sessionId);
      const observation = await this.#browser.click(sessionId, expectedRevision, ref);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.click",
        operation: "click_managed_browser_element",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: {
          sessionId,
          ref,
          expectedRevision,
          resultingRevision: observation.revision,
          resultingUrl: observation.url,
        },
      });
      return { ...observation, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.click",
        operation: "click_managed_browser_element",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId, ref, expectedRevision },
      });
      throw error;
    }
  }

  async typeBrowser(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    expectedRevision: string,
    ref: string,
    text: string,
    replace = true,
    submit = false,
  ): Promise<BrowserObservation & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    const textSha256 = sha256(text);
    try {
      this.#require(principal, workspaceId, ["browser.control", "network.access"]);
      this.#requireBrowserWorkspace(workspaceId, sessionId);
      const observation = await this.#browser.type(
        sessionId,
        expectedRevision,
        ref,
        text,
        replace,
        submit,
      );
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.type",
        operation: "type_managed_browser_element",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: {
          sessionId,
          ref,
          expectedRevision,
          resultingRevision: observation.revision,
          textSha256,
          characters: text.length,
          replace,
          submit,
          resultingUrl: observation.url,
        },
      });
      return { ...observation, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.type",
        operation: "type_managed_browser_element",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: {
          sessionId,
          ref,
          expectedRevision,
          textSha256,
          characters: text.length,
          replace,
          submit,
        },
      });
      throw error;
    }
  }

  async evaluateBrowser(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
    expression: string,
  ): Promise<{ readonly result: unknown; readonly receiptId: string }> {
    const receiptId = randomUUID();
    const expressionSha256 = sha256(expression);
    try {
      this.#require(principal, workspaceId, ["browser.control"]);
      this.#requireBrowserWorkspace(workspaceId, sessionId);
      const result = await this.#browser.evaluate(sessionId, expression);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.evaluate",
        operation: "evaluate_managed_browser",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: { sessionId, expressionSha256 },
      });
      return { result, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.evaluate",
        operation: "evaluate_managed_browser",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId, expressionSha256 },
      });
      throw error;
    }
  }

  async closeBrowserSession(
    principal: Principal,
    workspaceId: string,
    sessionId: string,
  ): Promise<BrowserSessionSummary & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    try {
      this.#require(principal, workspaceId, ["browser.control"]);
      this.#requireBrowserWorkspace(workspaceId, sessionId);
      const session = await this.#browser.close(sessionId);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.session.close",
        operation: "close_managed_browser_session",
        outcome: "succeeded",
        workspaceId,
        requestedPath: "",
        details: { sessionId },
      });
      return { ...session, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "browser.session.close",
        operation: "close_managed_browser_session",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: "",
        errorCode: codeOf(error),
        details: { sessionId },
      });
      throw error;
    }
  }

  async pythonCapabilities(
    principal: Principal,
    workspaceId: string,
  ): Promise<PythonRuntimeCapabilities> {
    this.#require(principal, workspaceId, ["system.read"]);
    const root = await this.#guard(workspaceId).realRoot();
    const runtime = await this.#pythonRuntime(root);
    return runtime === null
      ? {
          available: false,
          launcher: null,
          version: null,
          implementation: null,
          isolatedMode: true,
          networkIsolation: false,
        }
      : {
          available: true,
          launcher: runtime.launcher,
          version: runtime.version,
          implementation: runtime.implementation,
          isolatedMode: true,
          networkIsolation: false,
        };
  }

  async startPythonRun(
    principal: Principal,
    workspaceId: string,
    mode: "code" | "script",
    code: string | undefined,
    scriptPath: string | undefined,
    argumentList: readonly string[] = [],
    relativeCwd = "",
    artifactPaths: readonly string[] = [],
    timeoutMs = this.#processTimeoutMs,
  ): Promise<RunRecord> {
    const receiptId = randomUUID();
    let normalizedCwd: string | undefined;
    let normalizedScriptPath: string | undefined;
    const codeSha256 = code === undefined ? undefined : sha256(code);
    let normalizedArtifacts: readonly string[] = [];
    try {
      this.#require(principal, workspaceId, ["python.run"]);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Python timeout must be from 1000 through 900000 milliseconds.",
          400,
        );
      }
      if (
        argumentList.length > 128 ||
        argumentList.some((argument) => argument.length > 4_096 || argument.includes("\0"))
      ) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Python accepts at most 128 arguments of 4096 characters without NUL bytes.",
          400,
        );
      }
      if (artifactPaths.length > 64) {
        throw new RuntimeError("INVALID_INPUT", "Python accepts at most 64 declared artifacts.", 400);
      }
      normalizedArtifacts = [...new Set(artifactPaths.map((path) =>
        normalizeWindowsRelativePath(path)
      ))];

      const cwd = await this.#guard(workspaceId).resolve(relativeCwd, "read", true);
      normalizedCwd = cwd.relativePath;
      const cwdInfo = await lstat(cwd.absolutePath);
      if (!cwdInfo.isDirectory()) {
        throw new RuntimeError("PATH_NOT_DIRECTORY", "Python working directory must be a directory.", 400);
      }
      const runtime = await this.#pythonRuntime(cwd.absolutePath);
      if (runtime === null) {
        throw new RuntimeError(
          "PYTHON_UNAVAILABLE",
          "No supported Python 3 runtime is available through py, python, or python3.",
          503,
        );
      }

      let pythonArgs: string[];
      let label: string;
      if (mode === "code") {
        if (
          code === undefined ||
          code.length === 0 ||
          code.length > 1_048_576 ||
          code.includes("\0") ||
          scriptPath !== undefined
        ) {
          throw new RuntimeError(
            "INVALID_INPUT",
            "Code mode requires 1 through 1048576 characters of code and no scriptPath.",
            400,
          );
        }
        pythonArgs = [...runtime.prefixArgs, "-I", "-u", "-c", code, ...argumentList];
        label = "Python code";
      } else {
        if (scriptPath === undefined || scriptPath.length === 0 || code !== undefined) {
          throw new RuntimeError(
            "INVALID_INPUT",
            "Script mode requires one workspace-relative scriptPath and no inline code.",
            400,
          );
        }
        const script = await this.#guard(workspaceId).resolve(scriptPath, "read");
        normalizedScriptPath = script.relativePath;
        const scriptInfo = await lstat(script.absolutePath);
        if (!scriptInfo.isFile() || win32.extname(script.relativePath).toLowerCase() !== ".py") {
          throw new RuntimeError("FILE_NOT_REGULAR", "Python scriptPath must reference a regular .py file.", 400);
        }
        pythonArgs = [...runtime.prefixArgs, "-I", "-u", script.absolutePath, ...argumentList];
        label = `Python ${script.relativePath}`;
      }

      const run = this.#runs.start({
        kind: "python",
        label,
        workspaceId,
        command: runtime.command,
        args: pythonArgs,
        cwd: cwd.absolutePath,
        timeoutMs,
        env: {
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
        },
        metadata: {
          mode,
          relativeCwd: cwd.relativePath,
          runtime: {
            launcher: runtime.launcher,
            version: runtime.version,
            implementation: runtime.implementation,
          },
          ...(normalizedScriptPath === undefined ? {} : { scriptPath: normalizedScriptPath }),
          ...(codeSha256 === undefined ? {} : { codeSha256 }),
          argumentCount: argumentList.length,
          artifactPaths: normalizedArtifacts,
          timeoutMs,
          isolatedMode: true,
          networkIsolation: false,
        },
      });
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "python.start",
        operation: "start_python_run",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativeCwd,
        relativePath: cwd.relativePath,
        details: {
          runId: run.id,
          mode,
          ...(normalizedScriptPath === undefined ? {} : { scriptPath: normalizedScriptPath }),
          ...(codeSha256 === undefined ? {} : { codeSha256 }),
          artifactPaths: normalizedArtifacts,
          timeoutMs,
        },
      });
      return run;
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "python.start",
        operation: "start_python_run",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativeCwd,
        ...(normalizedCwd === undefined ? {} : { relativePath: normalizedCwd }),
        errorCode: codeOf(error),
        details: {
          mode,
          ...(normalizedScriptPath === undefined ? {} : { scriptPath: normalizedScriptPath }),
          ...(codeSha256 === undefined ? {} : { codeSha256 }),
          artifactPaths: normalizedArtifacts,
          timeoutMs,
        },
      });
      throw error;
    }
  }

  workflowTemplates(principal: Principal): readonly Readonly<Record<string, unknown>>[] {
    this.#policy.require(principal, ["system.read"]);
    return [
      {
        id: "verify",
        label: "Typecheck and test",
        steps: [
          { kind: "validation", task: "typecheck" },
          { kind: "validation", task: "test" },
        ],
      },
      {
        id: "release-check",
        label: "Typecheck, test, and build",
        steps: [
          { kind: "validation", task: "typecheck" },
          { kind: "validation", task: "test" },
          { kind: "validation", task: "build" },
        ],
      },
    ];
  }

  async startWorkflowRun(
    principal: Principal,
    workspaceId: string,
    label: string,
    steps: readonly WorkflowStep[],
    relativeCwd = "",
    timeoutMs = 900_000,
  ): Promise<RunRecord> {
    const receiptId = randomUUID();
    let normalizedCwd: string | undefined;
    const stepMetadata: Readonly<Record<string, unknown>>[] = [];
    try {
      this.#require(principal, workspaceId, ["workflow.run"]);
      const normalizedLabel = label.trim();
      if (normalizedLabel.length === 0 || normalizedLabel.length > 200) {
        throw new RuntimeError("INVALID_INPUT", "Workflow label must contain 1 through 200 characters.", 400);
      }
      if (steps.length < 1 || steps.length > 20) {
        throw new RuntimeError("INVALID_INPUT", "Workflow must contain 1 through 20 steps.", 400);
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Workflow timeout must be from 1000 through 3600000 milliseconds.",
          400,
        );
      }
      const cwd = await this.#guard(workspaceId).resolve(relativeCwd, "read", true);
      normalizedCwd = cwd.relativePath;
      const cwdInfo = await lstat(cwd.absolutePath);
      if (!cwdInfo.isDirectory()) {
        throw new RuntimeError("PATH_NOT_DIRECTORY", "Workflow working directory must be a directory.", 400);
      }

      const powerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
      const scriptLines = [
        "$ErrorActionPreference = 'Stop';",
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
      ];
      let pythonRuntime: PythonRuntimeSpec | null | undefined;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step === undefined) {
          throw new RuntimeError("INTERNAL_ERROR", "Workflow step state is inconsistent.", 500);
        }
        const ordinal = index + 1;
        scriptLines.push(`Write-Output ${powerShellLiteral(`[workflow ${ordinal}/${steps.length}] ${step.kind}`)};`);
        if (step.kind === "validation") {
          scriptLines.push(`& pnpm ${step.task}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE };`);
          stepMetadata.push({ kind: step.kind, task: step.task });
        } else if (step.kind === "terminal") {
          const command = step.command.trim();
          if (command.length === 0 || command.length > 8_192 || command.includes("\0")) {
            throw new RuntimeError(
              "INVALID_INPUT",
              `Workflow terminal step ${ordinal} must contain 1 through 8192 characters and no NUL bytes.`,
              400,
            );
          }
          scriptLines.push(`& { ${command} }; if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE };`);
          stepMetadata.push({ kind: step.kind, commandSha256: sha256(command) });
        } else {
          if (step.code.length === 0 || step.code.length > 32_768 || step.code.includes("\0")) {
            throw new RuntimeError(
              "INVALID_INPUT",
              `Workflow Python step ${ordinal} must contain 1 through 32768 characters and no NUL bytes.`,
              400,
            );
          }
          pythonRuntime ??= await this.#pythonRuntime(cwd.absolutePath);
          if (pythonRuntime === null) {
            throw new RuntimeError(
              "PYTHON_UNAVAILABLE",
              "No supported Python 3 runtime is available for the workflow.",
              503,
            );
          }
          const codeBase64 = Buffer.from(step.code, "utf8").toString("base64");
          const prefixArguments = pythonRuntime.prefixArgs
            .map((argument) => powerShellLiteral(argument))
            .join(" ");
          scriptLines.push(
            `$scrCode = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powerShellLiteral(codeBase64)})); ` +
              `& ${powerShellLiteral(pythonRuntime.command)} ${prefixArguments} '-I' '-u' '-c' $scrCode; ` +
              "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE };",
          );
          stepMetadata.push({ kind: step.kind, codeSha256: sha256(step.code) });
        }
      }
      scriptLines.push("Write-Output '[workflow] completed';");
      const script = scriptLines.join(" ");
      if (script.length > 28_000) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "The compiled workflow exceeds the Windows command-line limit. Split it into smaller workflows.",
          400,
        );
      }
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const powershell = win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const run = this.#runs.start({
        kind: "workflow",
        label: normalizedLabel,
        workspaceId,
        command: powershell,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        cwd: cwd.absolutePath,
        timeoutMs,
        metadata: {
          relativeCwd: cwd.relativePath,
          steps: stepMetadata,
          timeoutMs,
        },
      });
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "workflow.start",
        operation: "start_workflow_run",
        outcome: "succeeded",
        workspaceId,
        requestedPath: relativeCwd,
        relativePath: cwd.relativePath,
        details: { runId: run.id, label: normalizedLabel, steps: stepMetadata, timeoutMs },
      });
      return run;
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "workflow.start",
        operation: "start_workflow_run",
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath: relativeCwd,
        ...(normalizedCwd === undefined ? {} : { relativePath: normalizedCwd }),
        errorCode: codeOf(error),
        details: { label, steps: stepMetadata, timeoutMs },
      });
      throw error;
    }
  }

  computerCapabilities(principal: Principal): Readonly<Record<string, unknown>> {
    this.#policy.require(principal, ["system.read"]);
    return {
      available: this.#computer.available(),
      observationRevisionRequired: true,
      operations: ["focus_window", "click", "type_text", "press_key", "launch_application"],
    };
  }

  async observeComputer(
    principal: Principal,
    workspaceId: string,
    includeScreenshot = false,
  ): Promise<ComputerObservation> {
    this.#require(principal, workspaceId, ["computer.observe"]);
    return await this.#computer.observe(includeScreenshot);
  }

  async actComputer(
    principal: Principal,
    workspaceId: string,
    expectedRevision: string,
    input: ComputerActionInput,
  ): Promise<ComputerObservation & { readonly receiptId: string }> {
    const receiptId = randomUUID();
    let action: ComputerAction;
    let requestedPath = "";
    try {
      this.#require(principal, workspaceId, ["computer.control"]);
      if (input.operation === "launch_application") {
        const resolved = await this.#guard(workspaceId).resolve(input.path, "read");
        const info = await lstat(resolved.absolutePath);
        if (!info.isFile() || win32.extname(resolved.absolutePath).toLowerCase() !== ".exe") {
          throw new RuntimeError(
            "FILE_NOT_REGULAR",
            "Computer application launch requires a contained .exe file.",
            400,
          );
        }
        requestedPath = resolved.relativePath;
        action = { operation: "launch_application", absolutePath: resolved.absolutePath };
      } else {
        action = input;
      }
      const observation = await this.#computer.act(expectedRevision, action);
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "computer.action",
        operation: input.operation,
        outcome: "succeeded",
        workspaceId,
        requestedPath,
        ...(requestedPath.length === 0 ? {} : { relativePath: requestedPath }),
        details: {
          expectedRevision,
          resultingRevision: observation.revision,
          operation: input.operation,
          ...(input.operation === "type_text" ? { textSha256: sha256(input.text) } : {}),
        },
      });
      return { ...observation, receiptId };
    } catch (error) {
      this.#appendWriteReceipt({
        id: receiptId,
        principal,
        toolName: "computer.action",
        operation: input.operation,
        outcome: outcomeOf(error),
        workspaceId,
        requestedPath,
        ...(requestedPath.length === 0 ? {} : { relativePath: requestedPath }),
        errorCode: codeOf(error),
        details: {
          expectedRevision,
          operation: input.operation,
          ...(input.operation === "type_text" ? { textSha256: sha256(input.text) } : {}),
        },
      });
      throw error;
    }
  }

  async runValidation(
    principal: Principal,
    workspaceId: string,
    task: "typecheck" | "test" | "build",
  ): Promise<ProcessResult> {
    this.#require(principal, workspaceId, ["validation.run"]);
    const root = await this.#guard(workspaceId).realRoot();
    const processSpec = validationProcess(task);
    return runBoundedProcess(
      processSpec.command,
      processSpec.args,
      root,
      processSpec.label,
      this.#processTimeoutMs,
      this.#maxProcessOutputBytes,
      processSpec.windowsVerbatimArguments,
      true,
    );
  }

  async startValidationRun(
    principal: Principal,
    workspaceId: string,
    task: "typecheck" | "test" | "build",
    timeoutMs = this.#processTimeoutMs,
  ): Promise<RunRecord> {
    this.#require(principal, workspaceId, ["validation.run"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Run timeout must be from 1000 through 900000 milliseconds.",
        400,
      );
    }
    const root = await this.#guard(workspaceId).realRoot();
    const processSpec = validationProcess(task);
    return this.#runs.start({
      kind: "validation",
      label: processSpec.label,
      workspaceId,
      command: processSpec.command,
      args: processSpec.args,
      windowsVerbatimArguments: processSpec.windowsVerbatimArguments,
      cwd: root,
      timeoutMs,
      metadata: { task },
    });
  }

  listRuns(
    principal: Principal,
    workspaceId: string,
    limit = 100,
  ): readonly RunSummary[] {
    this.#require(principal, workspaceId, ["runs.read"]);
    return this.#runs
      .list(Math.max(1, Math.min(limit, 500)), workspaceId)
      .filter((run) => run.workspaceId === workspaceId)
      .map((run) => summarizeRun(run));
  }

  getRun(principal: Principal, workspaceId: string, runId: string): RunRecord {
    this.#require(principal, workspaceId, ["runs.read"]);
    const run = this.#runs.get(runId);
    if (run === null || run.workspaceId !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested run was not found.", 404);
    }
    return run;
  }

  async waitRun(
    principal: Principal,
    workspaceId: string,
    runId: string,
    waitMs = 15_000,
  ): Promise<RunRecord> {
    this.#require(principal, workspaceId, ["runs.read"]);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Run wait must be from 0 through 25000 milliseconds.",
        400,
      );
    }
    const existing = this.#runs.get(runId);
    if (existing === null || existing.workspaceId !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested run was not found.", 404);
    }
    const run = await this.#runs.wait(runId, waitMs);
    if (run === null || run.workspaceId !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested run was not found.", 404);
    }
    return run;
  }

  async followRun(
    principal: Principal,
    workspaceId: string,
    runId: string,
    cursor?: string,
    waitMs = 15_000,
    maxBytes = 65_536,
  ): Promise<RunFollowResult> {
    this.#require(principal, workspaceId, ["runs.read"]);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Run follow wait must be from 0 through 25000 milliseconds.",
        400,
      );
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 262_144) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Run follow maxBytes must be from 256 through 262144 per stream.",
        400,
      );
    }
    let run = this.#runs.get(runId);
    if (run === null || run.workspaceId !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested run was not found.", 404);
    }
    let result = followRunSnapshot(run, cursor, maxBytes);
    if (waitMs > 0 && !result.terminal && !runFollowHasDelta(result)) {
      run = await this.#runs.waitForChange(
        runId,
        {
          state: run.state,
          stdoutBytes: result.run.stdoutBytes,
          stderrBytes: result.run.stderrBytes,
          stdoutEndOffset: runOutputRange(run, "stdout").endOffset,
          stderrEndOffset: runOutputRange(run, "stderr").endOffset,
          outputTruncated: result.outputTruncated,
          cancelRequested: run.cancelRequested,
        },
        waitMs,
      );
      if (run === null || run.workspaceId !== workspaceId) {
        throw new RuntimeError("RUN_NOT_FOUND", "The requested run was not found.", 404);
      }
      result = followRunSnapshot(run, cursor, maxBytes);
    }
    return result;
  }

  cancelRun(principal: Principal, workspaceId: string, runId: string): RunRecord {
    this.#require(principal, workspaceId, ["runs.cancel"]);
    const existing = this.#runs.get(runId);
    if (existing === null || existing.workspaceId !== workspaceId) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested run was not found.", 404);
    }
    return this.#runs.cancel(runId) ?? existing;
  }

  ownedProcesses(): readonly OwnedRuntimeProcess[] {
    const managedRuns = this.#runs.activeProcesses().map((run) => ({
      processId: run.processId,
      role: "managed-run" as const,
      label: `${run.kind} · ${run.label}`,
    }));
    const terminals = this.#terminals.list().flatMap((session) =>
      (session.state === "starting" || session.state === "running") && session.processId !== null
        ? [{
            processId: session.processId,
            role: "terminal" as const,
            label: `ConPTY · ${session.relativeCwd || "workspace root"}`,
          }]
        : [],
    );
    const browsers = this.#browser.list().flatMap((session) =>
      (session.state === "starting" || session.state === "ready") && session.processId !== null
        ? [{
            processId: session.processId,
            role: "browser" as const,
            label: session.title.length === 0 ? "Managed Edge" : `Managed Edge · ${session.title}`,
          }]
        : [],
    );
    return [...managedRuns, ...terminals, ...browsers]
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.processId === entry.processId) === index)
      .sort((left, right) => left.processId - right.processId);
  }

  async shutdown(): Promise<void> {
    this.#computer.close();
    this.#runCompletionNotifier.close();
    await Promise.allSettled([
      this.#terminals.shutdown(),
      this.#browser.shutdown(),
      this.#runs.shutdown(),
    ]);
    this.#notifications.close();
  }

  listAuditReceipts(principal: Principal, limit = 100): readonly AuditReceipt[] {
    this.#policy.require(principal, ["system.read"]);
    return this.#audit.list(limit);
  }
}
