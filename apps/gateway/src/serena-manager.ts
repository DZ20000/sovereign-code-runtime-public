import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import { RuntimeError } from "@sovereign/runtime-core";

export const SERENA_REVIEWED_VERSION = "1.7.0" as const;

export const SERENA_READ_ONLY_TOOLS = [
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "find_declaration",
  "get_diagnostics_for_file",
] as const;

export type SerenaReadOnlyToolName = (typeof SERENA_READ_ONLY_TOOLS)[number];

export const SERENA_SEMANTIC_STATUS_SCHEMA_VERSION =
  "scr.semantic-code/status/v1" as const;

export interface SemanticCodeProvider {
  status(): SerenaSemanticStatus;
  probe(): Promise<SerenaSemanticStatus>;
  call(
    toolName: SerenaReadOnlyToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  deactivate(): Promise<void>;
  stop(): Promise<void>;
}

export interface SerenaSemanticStatus {
  readonly schemaVersion: typeof SERENA_SEMANTIC_STATUS_SCHEMA_VERSION;
  readonly provider: "serena";
  readonly state: "idle" | "starting" | "ready" | "failed" | "closed";
  readonly executable: string;
  readonly executableVersion: string | null;
  readonly expectedExecutableVersion: string | null;
  readonly workspaceFingerprint: string;
  readonly allowedTools: readonly SerenaReadOnlyToolName[];
  readonly processId: number | null;
  readonly startedAt: string | null;
  readonly lastError: string | null;
}

export interface SerenaSemanticManagerOptions {
  readonly workspaceRoot: string;
  readonly profileRoot: string;
  readonly executablePath?: string;
  readonly expectedExecutableVersion?: string | null;
  readonly versionProbeArguments?: readonly string[];
  readonly serverArguments?: readonly string[];
  readonly toolTimeoutMs?: number;
  readonly maximumResultBytes?: number;
}

type ManagerState = SerenaSemanticStatus["state"];

interface SerenaTextContent {
  readonly type: "text";
  readonly text: string;
}

interface SerenaCallResult {
  readonly isError?: boolean;
  readonly content?: readonly unknown[];
}

function yamlString(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\0\r\n]+/gu, " ").slice(0, 1_000);
}

function isContainedPath(root: string, candidate: string): boolean {
  const contained = relative(root, candidate);
  return (
    contained.length === 0 ||
    (contained !== ".." &&
      !contained.startsWith(`..${sep}`) &&
      !isAbsolute(contained))
  );
}

function isTextContent(value: unknown): value is SerenaTextContent {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { readonly type?: unknown }).type === "text" &&
    typeof (value as { readonly text?: unknown }).text === "string"
  );
}

function normalizeResult(
  toolName: SerenaReadOnlyToolName,
  value: SerenaCallResult,
  maximumResultBytes: number,
): unknown {
  const text = (value.content ?? [])
    .filter(isTextContent)
    .map((content) => content.text)
    .join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maximumResultBytes) {
    throw new RuntimeError(
      "FILE_TOO_LARGE",
      `Semantic result for ${toolName} exceeded ${maximumResultBytes} bytes.`,
      413,
    );
  }
  if (value.isError === true) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      text.length === 0
        ? `Serena tool failed: ${toolName}`
        : text.slice(0, 2_000),
      502,
    );
  }
  if (text.length === 0) {
    return {
      provider: "serena",
      toolName,
      result: null,
    };
  }
  try {
    return {
      provider: "serena",
      toolName,
      result: JSON.parse(text) as unknown,
    };
  } catch {
    return {
      provider: "serena",
      toolName,
      result: text,
    };
  }
}

function assertAllowedTools(toolNames: readonly string[]): void {
  const expected = [...SERENA_READ_ONLY_TOOLS].sort();
  const actual = [...toolNames].sort();
  if (
    expected.length !== actual.length ||
    expected.some((name, index) => name !== actual[index])
  ) {
    throw new RuntimeError(
      "POLICY_DENIED",
      "Serena exposed a tool set outside the reviewed read-only allowlist.",
      403,
      { expected, actual },
    );
  }
}

export class SerenaSemanticManager implements SemanticCodeProvider {
  readonly #workspaceRoot: string;
  readonly #profileRoot: string;
  readonly #executablePath: string;
  readonly #expectedExecutableVersion: string | null;
  readonly #versionProbeArguments: readonly string[];
  readonly #serverArguments: readonly string[];
  readonly #toolTimeoutMs: number;
  readonly #maximumResultBytes: number;
  readonly #workspaceFingerprint: string;
  #state: ManagerState = "idle";
  #client: Client | null = null;
  #transport: StdioClientTransport | null = null;
  #startPromise: Promise<void> | null = null;
  #operationQueue: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #startedAt: string | null = null;
  #lastError: string | null = null;
  #executableVersion: string | null = null;
  #stderr = "";

  constructor(options: SerenaSemanticManagerOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#profileRoot = resolve(options.profileRoot);
    this.#executablePath = options.executablePath ?? "serena";
    this.#expectedExecutableVersion = options.expectedExecutableVersion ?? null;
    if (
      this.#expectedExecutableVersion !== null &&
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(this.#expectedExecutableVersion)
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Expected Serena executable version is not a bounded semantic version.",
        400,
      );
    }
    this.#versionProbeArguments = options.versionProbeArguments ?? ["--version"];
    if (
      this.#versionProbeArguments.length === 0 ||
      this.#versionProbeArguments.length > 8 ||
      this.#versionProbeArguments.some((argument) =>
        argument.length === 0 || argument.length > 4_096 || argument.includes("\0")
      )
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Serena version probe arguments are outside the accepted bounds.",
        400,
      );
    }
    this.#toolTimeoutMs = Math.max(
      5_000,
      Math.min(options.toolTimeoutMs ?? 90_000, 240_000),
    );
    this.#maximumResultBytes = Math.max(
      4_096,
      Math.min(options.maximumResultBytes ?? 262_144, 1_048_576),
    );
    this.#workspaceFingerprint = createHash("sha256")
      .update(this.#workspaceRoot.toLocaleLowerCase("en-US"), "utf8")
      .digest("hex");
    this.#serverArguments = options.serverArguments ?? [
      "start-mcp-server",
      "--context",
      "claude-code",
      "--project",
      this.#workspaceRoot,
      "--transport",
      "stdio",
      "--language-backend",
      "LSP",
      "--enable-web-dashboard",
      "false",
      "--enable-gui-log-window",
      "false",
      "--open-web-dashboard",
      "false",
      "--log-level",
      "ERROR",
      "--tool-timeout",
      String(this.#toolTimeoutMs / 1_000),
    ];
  }

  status(): SerenaSemanticStatus {
    return {
      schemaVersion: SERENA_SEMANTIC_STATUS_SCHEMA_VERSION,
      provider: "serena",
      state: this.#state,
      executable: basename(this.#executablePath),
      executableVersion: this.#executableVersion,
      expectedExecutableVersion: this.#expectedExecutableVersion,
      workspaceFingerprint: this.#workspaceFingerprint,
      allowedTools: [...SERENA_READ_ONLY_TOOLS],
      processId: this.#transport?.pid ?? null,
      startedAt: this.#startedAt,
      lastError: this.#lastError,
    };
  }

  async probe(): Promise<SerenaSemanticStatus> {
    await this.#ensureReady();
    return this.status();
  }

  call(
    toolName: SerenaReadOnlyToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    let output: unknown;
    const operation = async (): Promise<void> => {
      await this.#ensureReady();
      const client = this.#client;
      if (client === null) {
        throw new RuntimeError(
          "INTERNAL_ERROR",
          "Semantic provider did not retain its connected client.",
          500,
        );
      }
      const normalizedInput = await this.#normalizeInput(input);
      try {
        const result = await client.callTool(
          {
            name: toolName,
            arguments: normalizedInput,
          },
          undefined,
          {
            timeout: this.#toolTimeoutMs,
            maxTotalTimeout: this.#toolTimeoutMs,
          },
        );
        output = normalizeResult(
          toolName,
          result as SerenaCallResult,
          this.#maximumResultBytes,
        );
      } catch (error) {
        if (error instanceof RuntimeError) {
          throw new RuntimeError(error.code, this.#redact(error), error.status);
        }
        throw new RuntimeError(
          "PROCESS_FAILED",
          `Serena ${toolName} failed: ${this.#redact(error)}`,
          502,
        );
      }
    };
    const queued = this.#operationQueue.then(operation, operation);
    this.#operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued.then(() => output);
  }

  deactivate(): Promise<void> {
    if (this.#state === "closed" || this.#stopRequested) {
      return Promise.resolve();
    }
    const operation = async (): Promise<void> => {
      if (this.#state === "closed" || this.#stopRequested) {
        return;
      }
      await this.#startPromise?.catch(() => undefined);
      const client = this.#client;
      this.#client = null;
      this.#transport = null;
      this.#state = "idle";
      this.#startedAt = null;
      await client?.close().catch(() => undefined);
    };
    const queued = this.#operationQueue.then(operation, operation);
    this.#operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  stop(): Promise<void> {
    if (this.#state === "closed") {
      return Promise.resolve();
    }
    if (this.#stopRequested) {
      return this.#operationQueue;
    }
    this.#stopRequested = true;
    const operation = async (): Promise<void> => {
      await this.#startPromise?.catch(() => undefined);
      const client = this.#client;
      this.#client = null;
      this.#transport = null;
      this.#state = "closed";
      this.#startedAt = null;
      await client?.close().catch(() => undefined);
    };
    const queued = this.#operationQueue.then(operation, operation);
    this.#operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async #ensureReady(): Promise<void> {
    if (this.#state === "closed" || this.#stopRequested) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Semantic provider is closed.",
        503,
      );
    }
    if (this.#state === "ready" && this.#client !== null) {
      return;
    }
    if (this.#startPromise !== null) {
      return await this.#startPromise;
    }
    this.#startPromise = this.#startNow().finally(() => {
      this.#startPromise = null;
    });
    return await this.#startPromise;
  }

  async #startNow(): Promise<void> {
    this.#state = "starting";
    this.#lastError = null;
    this.#stderr = "";
    let client: Client | null = null;
    try {
      await this.#verifyExecutableVersion();
      await this.#writeConfig();
      const transport = new StdioClientTransport({
        command: this.#executablePath,
        args: [...this.#serverArguments],
        cwd: this.#workspaceRoot,
        env: {
          ...getDefaultEnvironment(),
          USERPROFILE: this.#profileRoot,
          HOME: this.#profileRoot,
        },
        stderr: "pipe",
        maxBufferSize: 10 * 1_024 * 1_024,
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const value =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.#stderr = `${this.#stderr}${value}`.slice(-16_384);
      });
      client = new Client({
        name: "sovereign-semantic-code",
        version: "1.0.0",
      });
      await client.connect(transport);
      const listed = await client.listTools();
      assertAllowedTools(listed.tools.map((tool) => tool.name));
      client.onclose = () => {
        if (this.#state === "ready") {
          this.#client = null;
          this.#transport = null;
          this.#state = "failed";
          this.#lastError = "Serena semantic sidecar closed unexpectedly.";
        }
      };
      this.#client = client;
      this.#transport = transport;
      this.#state = "ready";
      this.#startedAt = new Date().toISOString();
      this.#lastError = null;
    } catch (error) {
      await client?.close().catch(() => undefined);
      this.#client = null;
      this.#transport = null;
      this.#state = "failed";
      const stderr = this.#stderr.trim();
      this.#lastError = this.#redact(
        stderr.length === 0 ? error : `${safeMessage(error)} ${stderr}`,
      );
      throw new RuntimeError(
        "PROCESS_FAILED",
        `Serena semantic provider could not start: ${this.#lastError}`,
        503,
      );
    }
  }

  async #verifyExecutableVersion(): Promise<void> {
    const expected = this.#expectedExecutableVersion;
    this.#executableVersion = null;
    if (expected === null) {
      return;
    }

    const probe = await new Promise<{
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
    }>((resolveProbe, rejectProbe) => {
      const child = spawn(
        this.#executablePath,
        [...this.#versionProbeArguments],
        {
          cwd: this.#workspaceRoot,
          env: getDefaultEnvironment(),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const maximumBytes = 16_384;
      let retainedBytes = 0;
      let settled = false;

      const reject = (error: RuntimeError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.kill();
        rejectProbe(error);
      };
      const append = (target: Buffer[], chunk: Buffer): void => {
        const remaining = maximumBytes - retainedBytes;
        if (remaining <= 0 || chunk.byteLength > remaining) {
          reject(new RuntimeError(
            "PROCESS_FAILED",
            "Serena version output exceeded the bounded probe limit.",
            502,
          ));
          return;
        }
        target.push(chunk);
        retainedBytes += chunk.byteLength;
      };

      child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
      const timer = setTimeout(() => {
        reject(new RuntimeError(
          "PROCESS_TIMEOUT",
          "Serena version probe exceeded 10000 milliseconds.",
          504,
        ));
      }, 10_000);
      timer.unref();
      child.once("error", (error) => {
        reject(new RuntimeError(
          "PROCESS_FAILED",
          `Could not start the Serena executable: ${safeMessage(error)}`,
          503,
        ));
      });
      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveProbe({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
        });
      });
    });

    if (probe.exitCode !== 0) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Serena version probe returned a non-zero exit code.",
        503,
      );
    }
    const output = `${probe.stdout}
${probe.stderr}`;
    const match = /(?:^|\s)Serena\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/u.exec(output);
    if (match === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Serena version probe did not return a recognized bounded version.",
        503,
      );
    }
    const actual = match[1]!;
    this.#executableVersion = actual;
    if (actual !== expected) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Serena version ${actual} does not match the reviewed version ${expected}.`,
        403,
        { actual, expected },
      );
    }
  }

  async #writeConfig(): Promise<void> {
    if (isContainedPath(this.#workspaceRoot, this.#profileRoot)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Serena profile and cache storage must remain outside the authorized workspace.",
        400,
      );
    }
    const configDirectory = join(this.#profileRoot, ".serena");
    const projectsDirectory = join(this.#profileRoot, "projects");
    await Promise.all([
      mkdir(configDirectory, { recursive: true }),
      mkdir(projectsDirectory, { recursive: true }),
    ]);
    const [canonicalWorkspace, canonicalProfile] = await Promise.all([
      realpath(this.#workspaceRoot),
      realpath(this.#profileRoot),
    ]);
    if (isContainedPath(canonicalWorkspace, canonicalProfile)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Serena profile storage resolves inside the authorized workspace.",
        400,
      );
    }
    const projectData = join(
      projectsDirectory,
      "$projectFolderName",
      ".serena",
    );
    const config = [
      "language_backend: LSP",
      "line_ending: native",
      "gui_log_window: false",
      "web_dashboard: false",
      "web_dashboard_open_on_launch: false",
      "log_level: 40",
      "trace_lsp_communication: false",
      `tool_timeout: ${this.#toolTimeoutMs / 1_000}`,
      "fixed_tools:",
      ...SERENA_READ_ONLY_TOOLS.map((tool) => `  - ${tool}`),
      "ignored_paths:",
      "  - .git/**",
      "  - .local-research/**",
      "  - .research/**",
      "  - .worktrees/**",
      "  - artifacts/**",
      "  - build/**",
      "  - coverage/**",
      "  - dist/**",
      "  - node_modules/**",
      "  - out/**",
      `project_serena_folder_location: ${yamlString(projectData)}`,
      "trusted_project_path_patterns:",
      `  - ${yamlString(this.#workspaceRoot)}`,
      "projects: []",
      "base_modes: []",
      "default_modes: []",
      "default_max_tool_answer_chars: 100000",
      "token_count_estimator: CHAR_COUNT",
      "",
    ].join("\n");
    const target = join(configDirectory, "serena_config.yml");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, config, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #normalizeInput(
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const normalized: Record<string, unknown> = { ...input };
    const relativePath = normalized.relative_path;
    if (relativePath !== undefined) {
      if (typeof relativePath !== "string") {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Semantic relative_path must be a string.",
          400,
        );
      }
      normalized.relative_path = await this.#containedRelativePath(
        relativePath,
        true,
      );
    }
    const maximum = normalized.max_answer_chars;
    if (
      maximum !== undefined &&
      (!Number.isInteger(maximum) ||
        (maximum as number) < 1_024 ||
        (maximum as number) > 100_000)
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Semantic max_answer_chars must be from 1024 through 100000.",
        400,
      );
    }
    return normalized;
  }

  async #containedRelativePath(
    candidate: string,
    allowEmpty: boolean,
  ): Promise<string> {
    const value = candidate.trim().replaceAll("\\", "/");
    if (value.length === 0 && allowEmpty) {
      return "";
    }
    if (
      value.length === 0 ||
      value.length > 4_096 ||
      value.includes("\0") ||
      value.includes(":") ||
      isAbsolute(value) ||
      value.startsWith("//") ||
      value
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
    ) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Semantic path must remain workspace-relative.",
        400,
      );
    }
    const lexical = resolve(this.#workspaceRoot, value);
    const lexicalRelative = relative(this.#workspaceRoot, lexical);
    if (
      lexicalRelative.length === 0 ||
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(lexicalRelative)
    ) {
      throw new RuntimeError(
        "PATH_ESCAPE",
        "Semantic path escapes the authorized workspace.",
        400,
      );
    }
    const info = await lstat(lexical).catch(() => null);
    if (info === null) {
      throw new RuntimeError(
        "PATH_NOT_FOUND",
        "Semantic path was not found.",
        404,
      );
    }
    if (info.isSymbolicLink()) {
      throw new RuntimeError(
        "PATH_SYMLINK",
        "Semantic paths may not target symbolic links.",
        400,
      );
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(this.#workspaceRoot),
      realpath(lexical),
    ]);
    const canonicalRelative = relative(canonicalRoot, canonicalTarget);
    if (
      canonicalRelative.length === 0 ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      throw new RuntimeError(
        "PATH_ESCAPE",
        "Semantic path resolves outside the authorized workspace.",
        400,
      );
    }
    return lexicalRelative.split(sep).join("/");
  }

  #redact(error: unknown): string {
    return safeMessage(error)
      .replaceAll(this.#workspaceRoot, "<workspace>")
      .replaceAll(this.#profileRoot, "<profile>");
  }
}
