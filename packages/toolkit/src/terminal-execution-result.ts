import { RuntimeError } from "@sovereign/runtime-core";

function boundedReceiptId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

export function toolExecutionReceiptId(value: unknown): string | null {
  if (value instanceof RuntimeError) {
    return boundedReceiptId(value.details?.receiptId);
  }
  return value !== null && typeof value === "object"
    ? boundedReceiptId((value as { readonly receiptId?: unknown }).receiptId)
    : null;
}

export function terminalEvidencePersistenceError(error: unknown): RuntimeError {
  return new RuntimeError(
    "INTERNAL_ERROR",
    "Could not persist terminal execution evidence.",
    500,
    { cause: error instanceof Error ? error.message : String(error) },
  );
}

export function requireSuccessfulTerminalExecution<T>(result: T): T {
  const record =
    result !== null && typeof result === "object"
      ? (result as { readonly exitCode?: unknown })
      : null;
  const receiptId = toolExecutionReceiptId(result);
  if (receiptId === null) {
    throw new RuntimeError(
      "INTERNAL_ERROR",
      "terminal.exec completed without a verifiable execution receipt.",
      500,
    );
  }
  const exitCode = record?.exitCode;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    throw new RuntimeError(
      "INTERNAL_ERROR",
      "terminal.exec completed without a valid process exit code.",
      500,
      { receiptId },
    );
  }
  if (exitCode !== 0) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      `PowerShell command exited with code ${exitCode}.`,
      409,
      { receiptId, exitCode },
    );
  }
  return result;
}
