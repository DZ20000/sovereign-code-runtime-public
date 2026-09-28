import { RuntimeError } from "@sovereign/runtime-core";

interface PositionalWriter {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesWritten: number }>;
}

/**
 * Complete a positional write, including valid short writes. The caller owns
 * truncation, synchronization, and closing. This is not a lock or a rollback:
 * a later I/O error may leave earlier chunks on disk.
 */
export async function writeAllAtStart(
  handle: PositionalWriter,
  data: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const remaining = data.byteLength - offset;
    const { bytesWritten } = await handle.write(data, offset, remaining, offset);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > remaining
    ) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        "The file write did not make valid progress.",
        500,
      );
    }
    offset += bytesWritten;
  }
}
