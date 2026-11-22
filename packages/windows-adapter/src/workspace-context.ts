import { createHash } from "node:crypto";
import { extname } from "node:path";

import { RuntimeError } from "@sovereign/runtime-core";

export const WORKSPACE_CONTEXT_SCHEMA_VERSION = "scr.workspace-context/v1" as const;
const WORKSPACE_CONTEXT_CURSOR_SCHEMA_VERSION = "scr.workspace-context-cursor/v2" as const;

const EXCLUDED_DIRECTORIES = [
  ".git",
  ".local-research",
  ".research",
  ".scr",
  ".worktrees",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
] as const;
const EXCLUDED_DIRECTORY_SET = new Set<string>(EXCLUDED_DIRECTORIES);
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
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

interface WorkspaceContextCursorPayload {
  readonly schemaVersion: typeof WORKSPACE_CONTEXT_CURSOR_SCHEMA_VERSION;
  readonly fingerprint: string;
  readonly fileIndex: number;
  readonly lineIndex: number;
  readonly pathChecked: boolean;
}

export interface WorkspaceContextProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly outputTruncated: boolean;
}

export interface WorkspaceContextReadResult {
  readonly content: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WorkspaceContextMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: {
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
  };
}

export interface WorkspaceContextDirtyFile {
  readonly status: string;
  readonly path: string;
}

export interface WorkspaceContextResult {
  readonly schemaVersion: typeof WORKSPACE_CONTEXT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly scopePath: string;
  readonly query: string | null;
  readonly branch: string | null;
  readonly dirtyFiles: readonly WorkspaceContextDirtyFile[];
  readonly matchingPaths: readonly string[];
  readonly matches: readonly WorkspaceContextMatch[];
  readonly candidateFileCount: number;
  readonly scannedFileCount: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly exclusions: readonly string[];
  readonly sourceTruncated: {
    readonly gitStatus: boolean;
    readonly gitFiles: boolean;
    readonly dirtyFiles: boolean;
  };
}

export interface WorkspaceContextOptions {
  readonly workspaceId: string;
  readonly scopePath: string;
  readonly query?: string;
  readonly cursor?: string;
  readonly maxFiles: number;
  readonly maxMatches: number;
  readonly snippetLines: number;
  readonly maxBytes: number;
  readonly includeUntracked: boolean;
  readonly gitStatus: () => Promise<WorkspaceContextProcessResult>;
  readonly gitFiles: () => Promise<WorkspaceContextProcessResult>;
  readonly readText: (
    relativePath: string,
    maxBytes: number,
  ) => Promise<WorkspaceContextReadResult>;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isExcludedPath(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((segment) => EXCLUDED_DIRECTORY_SET.has(segment.toLocaleLowerCase("en-US")));
}

function inScope(path: string, scopePath: string): boolean {
  if (scopePath.length === 0) {
    return true;
  }
  return path === scopePath || path.startsWith(`${scopePath}/`);
}

function completedOutputLines(output: string, outputTruncated: boolean): string[] {
  const lines = output.split(/\r?\n/u);
  if (outputTruncated && output.length > 0 && !/[\r\n]$/u.test(output)) {
    lines.pop();
  }
  return lines.filter((line) => line.length > 0);
}

function parseFiles(
  output: string,
  scopePath: string,
  outputTruncated: boolean,
): string[] {
  return [...new Set(
    completedOutputLines(output, outputTruncated)
      .map((path) => normalizePath(path.trim()))
      .filter((path) => path.length > 0 && inScope(path, scopePath) && !isExcludedPath(path)),
  )].sort((left, right) => left.localeCompare(right));
}

function parseStatus(
  output: string,
  scopePath: string,
  outputTruncated: boolean,
): {
  readonly branch: string | null;
  readonly dirtyFiles: readonly WorkspaceContextDirtyFile[];
  readonly truncated: boolean;
} {
  const lines = completedOutputLines(output, outputTruncated);
  const branchLine = lines[0]?.startsWith("## ") === true ? lines.shift() : undefined;
  const dirtyFiles = lines.flatMap((line) => {
    if (line.length < 4) {
      return [];
    }
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const normalized = normalizePath(rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath);
    if (!inScope(normalized, scopePath) || isExcludedPath(normalized)) {
      return [];
    }
    return [{ status, path: normalized }];
  });
  return {
    branch: branchLine === undefined ? null : branchLine.slice(3),
    dirtyFiles: dirtyFiles.slice(0, 100),
    truncated: dirtyFiles.length > 100,
  };
}

function fingerprintFor(options: {
  readonly workspaceId: string;
  readonly scopePath: string;
  readonly query: string | null;
  readonly includeUntracked: boolean;
  readonly files: readonly string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify(options), "utf8")
    .digest("hex");
}

function encodeCursor(payload: WorkspaceContextCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  fingerprint: string,
): WorkspaceContextCursorPayload {
  if (cursor === undefined) {
    return {
      schemaVersion: WORKSPACE_CONTEXT_CURSOR_SCHEMA_VERSION,
      fingerprint,
      fileIndex: 0,
      lineIndex: 0,
      pathChecked: false,
    };
  }
  if (cursor.length === 0 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new RuntimeError("INVALID_INPUT", "Workspace context cursor is malformed.", 400);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid payload");
    }
    const value = parsed as Partial<WorkspaceContextCursorPayload>;
    if (
      value.schemaVersion !== WORKSPACE_CONTEXT_CURSOR_SCHEMA_VERSION ||
      value.fingerprint !== fingerprint ||
      !Number.isSafeInteger(value.fileIndex) ||
      !Number.isSafeInteger(value.lineIndex) ||
      (value.fileIndex ?? -1) < 0 ||
      (value.lineIndex ?? -1) < 0 ||
      typeof value.pathChecked !== "boolean"
    ) {
      throw new Error("invalid fields");
    }
    return value as WorkspaceContextCursorPayload;
  } catch {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Workspace context cursor is stale or does not match the current request.",
      400,
    );
  }
}

function itemBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

type WorkspaceContextResultBase = Omit<WorkspaceContextResult, "returnedBytes">;

function finalizeWorkspaceContext(
  base: WorkspaceContextResultBase,
): WorkspaceContextResult {
  let returnedBytes = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result: WorkspaceContextResult = { ...base, returnedBytes };
    const measuredBytes = itemBytes(result);
    if (measuredBytes === returnedBytes) {
      return result;
    }
    returnedBytes = measuredBytes;
  }
  throw new RuntimeError(
    "INTERNAL_ERROR",
    "Could not stabilize the workspace context response size.",
    500,
  );
}

function searchable(path: string): boolean {
  return SEARCHABLE_EXTENSIONS.has(extname(path).toLocaleLowerCase("en-US"));
}

function matchForLine(
  path: string,
  lines: readonly string[],
  lineIndex: number,
  column: number,
  snippetLines: number,
): WorkspaceContextMatch {
  const start = Math.max(0, lineIndex - snippetLines);
  const end = Math.min(lines.length, lineIndex + snippetLines + 1);
  return {
    path,
    line: lineIndex + 1,
    column: column + 1,
    snippet: {
      startLine: start + 1,
      endLine: end,
      text: lines
        .slice(start, end)
        .map((line, offset) => `${start + offset + 1}: ${line}`)
        .join("\n"),
    },
  };
}

export async function buildWorkspaceContext(
  options: WorkspaceContextOptions,
): Promise<WorkspaceContextResult> {
  const scopePath = normalizePath(options.scopePath);
  const query = options.query?.trim() ?? "";
  if (query.length > 500) {
    throw new RuntimeError("INVALID_INPUT", "Workspace context query exceeds 500 characters.", 400);
  }
  if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 500) {
    throw new RuntimeError("INVALID_INPUT", "Workspace context maxFiles must be from 1 through 500.", 400);
  }
  if (!Number.isInteger(options.maxMatches) || options.maxMatches < 1 || options.maxMatches > 200) {
    throw new RuntimeError("INVALID_INPUT", "Workspace context maxMatches must be from 1 through 200.", 400);
  }
  if (!Number.isInteger(options.snippetLines) || options.snippetLines < 0 || options.snippetLines > 5) {
    throw new RuntimeError("INVALID_INPUT", "Workspace context snippetLines must be from 0 through 5.", 400);
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 8_192 || options.maxBytes > 262_144) {
    throw new RuntimeError("INVALID_INPUT", "Workspace context maxBytes must be from 8192 through 262144.", 400);
  }

  const [statusResult, filesResult] = await Promise.all([
    options.gitStatus(),
    options.gitFiles(),
  ]);
  if (statusResult.exitCode !== 0) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      statusResult.stderr.length > 0
        ? statusResult.stderr
        : "Could not read Git workspace status.",
      500,
    );
  }
  if (filesResult.exitCode !== 0) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      filesResult.stderr.length > 0 ? filesResult.stderr : "Could not enumerate Git files.",
      500,
    );
  }
  const files = parseFiles(filesResult.stdout, scopePath, filesResult.outputTruncated);
  const status = parseStatus(statusResult.stdout, scopePath, statusResult.outputTruncated);
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  const fingerprint = fingerprintFor({
    workspaceId: options.workspaceId,
    scopePath,
    query: query.length === 0 ? null : normalizedQuery,
    includeUntracked: options.includeUntracked,
    files,
  });
  const cursor = decodeCursor(options.cursor, fingerprint);
  if (
    cursor.fileIndex > files.length ||
    (options.cursor !== undefined && cursor.fileIndex === files.length) ||
    (cursor.lineIndex > 0 && !cursor.pathChecked) ||
    (query.length === 0 && (cursor.lineIndex !== 0 || cursor.pathChecked))
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Workspace context cursor is not a valid page boundary.",
      400,
    );
  }

  const page = {
    fileIndex: cursor.fileIndex,
    lineIndex: cursor.lineIndex,
    pathChecked: cursor.pathChecked,
    scannedFileCount: 0,
    dirtyFiles: [] as WorkspaceContextDirtyFile[],
    dirtyFilesTruncated: status.truncated || status.dirtyFiles.length > 0,
    matchingPaths: [] as string[],
    matches: [] as WorkspaceContextMatch[],
  };
  const resultFor = (changes: Partial<typeof page> = {}): WorkspaceContextResult => {
    const state = { ...page, ...changes };
    const nextCursor = state.fileIndex < files.length
      ? encodeCursor({
          schemaVersion: WORKSPACE_CONTEXT_CURSOR_SCHEMA_VERSION,
          fingerprint,
          fileIndex: state.fileIndex,
          lineIndex: state.lineIndex,
          pathChecked: state.pathChecked,
        })
      : null;
    return finalizeWorkspaceContext({
      schemaVersion: WORKSPACE_CONTEXT_SCHEMA_VERSION,
      workspaceId: options.workspaceId,
      scopePath,
      query: query.length === 0 ? null : query,
      branch: status.branch,
      dirtyFiles: state.dirtyFiles,
      matchingPaths: state.matchingPaths,
      matches: state.matches,
      candidateFileCount: files.length,
      scannedFileCount: state.scannedFileCount,
      truncated:
        nextCursor !== null ||
        statusResult.outputTruncated ||
        filesResult.outputTruncated ||
        state.dirtyFilesTruncated,
      nextCursor,
      exclusions: [...EXCLUDED_DIRECTORIES],
      sourceTruncated: {
        gitStatus: statusResult.outputTruncated,
        gitFiles: filesResult.outputTruncated,
        dirtyFiles: state.dirtyFilesTruncated,
      },
    });
  };

  const emptyPage = resultFor();
  if (emptyPage.returnedBytes > options.maxBytes) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Workspace context maxBytes is too small for response metadata.",
      400,
      {
        maxBytes: options.maxBytes,
        metadataBytes: emptyPage.returnedBytes,
      },
    );
  }
  for (const [index, dirtyFile] of status.dirtyFiles.entries()) {
    const dirtyFiles = [...page.dirtyFiles, dirtyFile];
    const dirtyFilesTruncated = status.truncated || index + 1 < status.dirtyFiles.length;
    if (resultFor({ dirtyFiles, dirtyFilesTruncated }).returnedBytes > options.maxBytes) break;
    Object.assign(page, { dirtyFiles, dirtyFilesTruncated });
  }

  // Paths and text matches share one budget and advance only after being accepted.
  const appendItem = (
    item: string | WorkspaceContextMatch,
    next: Pick<WorkspaceContextCursorPayload, "fileIndex" | "lineIndex" | "pathChecked">,
  ): boolean => {
    const isPath = typeof item === "string";
    const addition = isPath
      ? { matchingPaths: [...page.matchingPaths, item] }
      : { matches: [...page.matches, item] };
    let candidate = resultFor({ ...next, ...addition });
    while (candidate.returnedBytes > options.maxBytes && page.dirtyFiles.length > 0) {
      page.dirtyFiles.pop();
      page.dirtyFilesTruncated = true;
      candidate = resultFor({ ...next, ...addition });
    }
    if (candidate.returnedBytes > options.maxBytes) {
      const isolated = resultFor({
        ...next,
        dirtyFiles: [],
        dirtyFilesTruncated: status.truncated || status.dirtyFiles.length > 0,
        matchingPaths: isPath ? [item] : [],
        matches: isPath ? [] : [item],
        scannedFileCount: 1,
      });
      if (isolated.returnedBytes > options.maxBytes) {
        const itemType = isPath ? "path" : "match";
        throw new RuntimeError(
          "INVALID_INPUT",
          `Workspace context ${itemType} cannot fit within maxBytes; increase maxBytes or narrow the request.`,
          400,
          {
            itemType,
            itemBytes: itemBytes(item),
            maxBytes: options.maxBytes,
            requiredBytes: isolated.returnedBytes,
          },
        );
      }
      return false;
    }
    Object.assign(page, next, addition);
    return true;
  };

  scan: while (page.fileIndex < files.length && page.scannedFileCount < options.maxFiles) {
    const path = files[page.fileIndex]!;
    const nextFile = { fileIndex: page.fileIndex + 1, lineIndex: 0, pathChecked: false };
    page.scannedFileCount += 1;
    if (query.length === 0) {
      if (!appendItem(path, nextFile)) break;
      continue;
    }

    if (!page.pathChecked) {
      if (
        path.toLocaleLowerCase("en-US").includes(normalizedQuery) &&
        !appendItem(path, {
          fileIndex: page.fileIndex,
          lineIndex: page.lineIndex,
          pathChecked: true,
        })
      ) break;
      page.pathChecked = true;
    }
    if (!searchable(path)) {
      Object.assign(page, nextFile);
      continue;
    }

    let read: WorkspaceContextReadResult;
    try {
      read = await options.readText(path, 262_144);
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        [
          "FILE_TOO_LARGE",
          "FILE_NOT_REGULAR",
          "PATH_REJECTED",
          "PATH_SYMLINK",
          "PATH_NOT_FOUND",
        ].includes(error.code)
      ) {
        Object.assign(page, nextFile);
        continue;
      }
      throw error;
    }
    const lines = read.content.split(/\r?\n/u);
    if (page.lineIndex > 0 && page.lineIndex >= lines.length) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Workspace context cursor line offset is outside the current file.",
        400,
      );
    }
    while (page.lineIndex < lines.length) {
      const column = lines[page.lineIndex]!.toLocaleLowerCase("en-US").indexOf(normalizedQuery);
      const nextLine = page.lineIndex + 1;
      if (column >= 0) {
        const completesFile = nextLine >= lines.length;
        const next = completesFile
          ? nextFile
          : { fileIndex: page.fileIndex, lineIndex: nextLine, pathChecked: true };
        const match = matchForLine(path, lines, page.lineIndex, column, options.snippetLines);
        if (!appendItem(match, next) || page.matches.length >= options.maxMatches) break scan;
        if (completesFile) break;
      } else {
        page.lineIndex = nextLine;
      }
    }
    if (page.lineIndex >= lines.length) Object.assign(page, nextFile);
  }

  const result = resultFor();
  if (result.returnedBytes > options.maxBytes) {
    throw new RuntimeError(
      "INTERNAL_ERROR",
      "Workspace context response exceeded its validated byte budget.",
      500,
    );
  }
  if (options.cursor !== undefined && result.nextCursor === options.cursor) {
    throw new RuntimeError(
      "INTERNAL_ERROR",
      "Workspace context pagination did not advance its cursor.",
      500,
    );
  }
  return result;
}
