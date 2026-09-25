import type { FileHandle } from "node:fs/promises";
import { lstat, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { RuntimeError } from "@sovereign/runtime-core";

const RESERVED_WINDOWS_NAMES =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_WINDOWS_SEGMENT_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;

export interface WorkspaceDefinition {
  readonly id: string;
  readonly root: string;
  readonly label?: string;
}

export interface ResolvedWorkspacePath {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertContained(root: string, candidate: string): void {
  const normalizedRoot = win32
    .resolve(root)
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase("en-US");
  const normalizedCandidate = win32
    .resolve(candidate)
    .toLocaleLowerCase("en-US");
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  ) {
    throw new RuntimeError(
      "PATH_ESCAPE",
      "The resolved path escapes the authorized workspace.",
      403,
    );
  }
}

export function normalizeWindowsRelativePath(
  input: string,
  allowEmpty = false,
): string {
  if (input.length > 4_096) {
    throw new RuntimeError(
      "PATH_REJECTED",
      "The path exceeds the maximum supported length.",
      400,
    );
  }
  if (input.includes("\0")) {
    throw new RuntimeError(
      "PATH_REJECTED",
      "NUL characters are not allowed in paths.",
      400,
    );
  }

  const value = input.replaceAll("/", "\\");
  if (value.length === 0 && allowEmpty) {
    return "";
  }
  if (value.length === 0) {
    throw new RuntimeError(
      "PATH_REJECTED",
      "A workspace-relative path is required.",
      400,
    );
  }
  if (
    /^[A-Za-z]:/.test(value) ||
    win32.isAbsolute(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("\\?\\") ||
    value.startsWith("\\.\\")
  ) {
    throw new RuntimeError(
      "PATH_REJECTED",
      "Absolute, drive-qualified, UNC, and device paths are not allowed.",
      400,
    );
  }

  const segments = value.split("\\");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Empty, current-directory, and parent-directory path segments are not allowed.",
        400,
      );
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Windows path segments may not end with a space or period.",
        400,
      );
    }
    if (INVALID_WINDOWS_SEGMENT_CHARACTERS.test(segment)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "The path contains a Windows-reserved character or NTFS stream separator.",
        400,
      );
    }
    if (RESERVED_WINDOWS_NAMES.test(segment)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "The path contains a reserved Windows device name.",
        400,
      );
    }
  }

  return segments.join("\\");
}

export class WindowsPathGuard {
  readonly workspaceId: string;
  readonly configuredRoot: string;
  #realRootPromise: Promise<string> | undefined;

  constructor(workspace: WorkspaceDefinition) {
    if (
      !win32.isAbsolute(workspace.root) ||
      !/^[A-Za-z]:[\\/]/.test(workspace.root)
    ) {
      throw new RuntimeError(
        "PATH_REJECTED",
        `Workspace ${workspace.id} must use an absolute Windows drive path.`,
        500,
      );
    }
    this.workspaceId = workspace.id;
    this.configuredRoot = win32.resolve(workspace.root);
  }

  async realRoot(): Promise<string> {
    this.#realRootPromise ??= (async () => {
      const rootInfo = await lstat(this.configuredRoot);
      if (!rootInfo.isDirectory()) {
        throw new RuntimeError(
          "PATH_NOT_DIRECTORY",
          "The configured workspace root is not a directory.",
          500,
        );
      }
      return realpath(this.configuredRoot);
    })();
    return this.#realRootPromise;
  }

  async assertOpenedRegularFile(
    absolutePath: string,
    handle: FileHandle,
  ): Promise<void> {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new RuntimeError("FILE_NOT_REGULAR", "Only regular files may be accessed.", 400);
    }
    if (opened.nlink !== 1n) {
      throw new RuntimeError(
        "FILE_LINKED",
        "Files with multiple hard links are outside the workspace trust boundary.",
        403,
      );
    }

    const root = await this.realRoot();
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(absolutePath);
      assertContained(root, canonicalPath);
      const current = await lstat(canonicalPath, { bigint: true });
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new RuntimeError(
          "PATH_CHANGED",
          "The file path changed while it was being opened.",
          409,
        );
      }
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw error;
      }
      throw new RuntimeError(
        "PATH_CHANGED",
        "The file path changed while it was being opened.",
        409,
      );
    }
  }

  async resolve(
    relativePath: string,
    access: "read" | "create",
    allowRoot = false,
  ): Promise<ResolvedWorkspacePath> {
    const normalized = normalizeWindowsRelativePath(relativePath, allowRoot);
    const root = await this.realRoot();
    if (normalized.length === 0) {
      return {
        workspaceId: this.workspaceId,
        relativePath: "",
        absolutePath: root,
      };
    }

    const lexicalCandidate = win32.join(root, normalized);
    assertContained(root, lexicalCandidate);

    const segments = normalized.split("\\");
    // Git metadata is executable surface: hooks run on commit, and config keys
    // such as core.fsmonitor run a command on ordinary status calls. File tools
    // stay out of it entirely; the git tools remain the supported path.
    if (segments.some((segment) => segment.toLocaleLowerCase("en-US") === ".git")) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Git metadata is not reachable through file tools.",
        403,
      );
    }
    const walkCount =
      access === "create" ? segments.length - 1 : segments.length;
    let current = root;

    for (let index = 0; index < walkCount; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        throw new RuntimeError(
          "INTERNAL_ERROR",
          "Path traversal state is inconsistent.",
          500,
        );
      }
      current = win32.join(current, segment);

      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new RuntimeError(
            "PATH_NOT_FOUND",
            "A required workspace path does not exist.",
            404,
          );
        }
        throw error;
      }

      if (info.isSymbolicLink()) {
        throw new RuntimeError(
          "PATH_SYMLINK",
          "Symbolic links and junctions are not traversed by the Windows adapter.",
          403,
        );
      }
      if (index < walkCount - 1 && !info.isDirectory()) {
        throw new RuntimeError(
          "PATH_NOT_DIRECTORY",
          "A path component is not a directory.",
          400,
        );
      }

      current = await realpath(current);
      assertContained(root, current);
    }

    if (access === "create") {
      const finalSegment = segments.at(-1);
      if (finalSegment === undefined) {
        throw new RuntimeError(
          "INTERNAL_ERROR",
          "Create path has no final segment.",
          500,
        );
      }
      const target = win32.join(current, finalSegment);
      assertContained(root, target);
      try {
        await lstat(target);
        throw new RuntimeError(
          "FILE_EXISTS",
          "The target already exists.",
          409,
        );
      } catch (error) {
        if (error instanceof RuntimeError) {
          throw error;
        }
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      return {
        workspaceId: this.workspaceId,
        relativePath: normalized,
        absolutePath: target,
      };
    }

    return {
      workspaceId: this.workspaceId,
      relativePath: normalized,
      absolutePath: current,
    };
  }
}
