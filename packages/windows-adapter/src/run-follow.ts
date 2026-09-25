import { TextDecoder } from "node:util";
import { runOutputRange, type OutputRange } from "./output-buffer.js";

import {
  RuntimeError,
  summarizeRun,
  type RunRecord,
  type RunSummary,
} from "@sovereign/runtime-core";

export const RUN_FOLLOW_SCHEMA_VERSION = "scr.run-follow/v1" as const;
const RUN_CURSOR_SCHEMA_VERSION = "scr.run-cursor/v1" as const;

interface RunCursorPayload {
  readonly schemaVersion: typeof RUN_CURSOR_SCHEMA_VERSION;
  readonly runId: string;
  readonly stdoutOffset: number;
  readonly stderrOffset: number;
}

export interface RunOutputDelta {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly retainedBytes: number;
  readonly retainedStartOffset: number;
  readonly skippedBytes: number;
  readonly hasMore: boolean;
}

export interface RunFollowResult {
  readonly schemaVersion: typeof RUN_FOLLOW_SCHEMA_VERSION;
  readonly run: RunSummary;
  readonly cursor: string;
  readonly stdout: RunOutputDelta;
  readonly stderr: RunOutputDelta;
  readonly outputTruncated: boolean;
  readonly terminal: boolean;
}

function invalidCursor(message: string): never {
  throw new RuntimeError("INVALID_INPUT", message, 400);
}

function decodeCursor(cursor: string | undefined, runId: string): RunCursorPayload {
  if (cursor === undefined) {
    return {
      schemaVersion: RUN_CURSOR_SCHEMA_VERSION,
      runId,
      stdoutOffset: 0,
      stderrOffset: 0,
    };
  }
  if (cursor.length === 0 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    return invalidCursor("Run cursor is malformed.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return invalidCursor("Run cursor payload is invalid.");
    }
    const value = parsed as Partial<RunCursorPayload>;
    if (
      value.schemaVersion !== RUN_CURSOR_SCHEMA_VERSION ||
      value.runId !== runId ||
      !Number.isSafeInteger(value.stdoutOffset) ||
      !Number.isSafeInteger(value.stderrOffset) ||
      (value.stdoutOffset ?? -1) < 0 ||
      (value.stderrOffset ?? -1) < 0
    ) {
      return invalidCursor("Run cursor does not match the requested run.");
    }
    return value as RunCursorPayload;
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    return invalidCursor("Run cursor could not be decoded.");
  }
}

function encodeCursor(payload: RunCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function assertUtf8Boundary(buffer: Buffer, offset: number): void {
  if (offset < 0 || offset > buffer.byteLength) {
    invalidCursor("Run cursor points outside retained output.");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    invalidCursor("Run cursor does not point to a UTF-8 boundary.");
  }
}

function outputDelta(value: string, offset: number, maxBytes: number, range: OutputRange): RunOutputDelta {
  const buffer = Buffer.from(value, "utf8");
  if (offset > range.endOffset) invalidCursor("Run cursor points beyond produced output.");
  const startOffset = Math.max(offset, range.startOffset);
  const localStart = startOffset - range.startOffset;
  assertUtf8Boundary(buffer, localStart);
  let localEnd = Math.min(buffer.byteLength, localStart + maxBytes);
  while (localEnd > localStart && localEnd < buffer.byteLength && (buffer[localEnd]! & 0xc0) === 0x80) localEnd -= 1;
  if (localEnd === localStart && localStart < buffer.byteLength) {
    invalidCursor("Run follow maxBytes is too small for the next UTF-8 character.");
  }
  return {
    text: buffer.subarray(localStart, localEnd).toString("utf8"),
    startOffset,
    endOffset: range.startOffset + localEnd,
    retainedBytes: buffer.byteLength,
    retainedStartOffset: range.startOffset,
    skippedBytes: startOffset - offset,
    hasMore: localEnd < buffer.byteLength,
  };
}

export function followRunSnapshot(
  run: RunRecord,
  cursor: string | undefined,
  maxBytes: number,
): RunFollowResult {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262_144) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Run follow maxBytes must be from 1 through 262144 per stream.",
      400,
    );
  }
  const decoded = decodeCursor(cursor, run.id);
  const stdout = outputDelta(run.stdout, decoded.stdoutOffset, maxBytes, runOutputRange(run, "stdout"));
  const stderr = outputDelta(run.stderr, decoded.stderrOffset, maxBytes, runOutputRange(run, "stderr"));
  return {
    schemaVersion: RUN_FOLLOW_SCHEMA_VERSION,
    run: summarizeRun(run),
    cursor: encodeCursor({
      schemaVersion: RUN_CURSOR_SCHEMA_VERSION,
      runId: run.id,
      stdoutOffset: stdout.endOffset,
      stderrOffset: stderr.endOffset,
    }),
    stdout,
    stderr,
    outputTruncated: run.outputTruncated,
    terminal: run.state !== "queued" && run.state !== "running",
  };
}

export function runFollowHasDelta(result: RunFollowResult): boolean {
  return (
    result.stdout.skippedBytes > 0 ||
    result.stderr.skippedBytes > 0 ||
    result.stdout.text.length > 0 ||
    result.stderr.text.length > 0 ||
    result.stdout.hasMore ||
    result.stderr.hasMore
  );
}
