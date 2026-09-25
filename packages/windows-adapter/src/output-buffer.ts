import { StringDecoder } from "node:string_decoder";

import { RuntimeError, type RunRecord } from "@sovereign/runtime-core";

export const OUTPUT_RETENTION_SCHEMA = "scr.output-retention/v1" as const;

/** Absolute byte offsets in the decoded UTF-8 stream, not in the raw pipe. */
export interface OutputRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface OutputRetention {
  readonly schemaVersion: typeof OUTPUT_RETENTION_SCHEMA;
  readonly stdout: OutputRange;
  readonly stderr: OutputRange;
}

export function assertOutputCapacity(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 67_108_864) {
    throw new RangeError("Output capacity must be from 4 through 67108864 bytes.");
  }
}

/** A fixed-capacity UTF-8 tail. Appending never copies the retained history. */
export class BoundedOutputBuffer {
  readonly #storage: Buffer;
  readonly #decoder = new StringDecoder("utf8");
  #start = 0;
  #length = 0;
  #totalBytes = 0;
  #finished = false;
  #cachedText: string | undefined;

  constructor(maxBytes: number) {
    assertOutputCapacity(maxBytes);
    this.#storage = Buffer.allocUnsafe(maxBytes);
  }

  append(chunk: Buffer): boolean {
    if (this.#finished) throw new Error("Cannot append to finished output.");
    return this.#appendText(this.#decoder.write(chunk));
  }

  finish(): void {
    if (this.#finished) return;
    this.#appendText(this.#decoder.end());
    this.#finished = true;
  }

  range(): OutputRange {
    return { startOffset: this.#totalBytes - this.#length, endOffset: this.#totalBytes };
  }

  truncated(): boolean {
    return this.#totalBytes > this.#length;
  }

  text(): string {
    if (this.#cachedText !== undefined) return this.#cachedText;
    const firstLength = Math.min(this.#length, this.#storage.length - this.#start);
    const first = this.#storage.subarray(this.#start, this.#start + firstLength);
    this.#cachedText = firstLength === this.#length
      ? first.toString("utf8")
      : Buffer.concat([first, this.#storage.subarray(0, this.#length - firstLength)]).toString("utf8");
    return this.#cachedText;
  }

  #appendText(text: string): boolean {
    if (text.length === 0) return false;
    const data = Buffer.from(text, "utf8");
    if (!Number.isSafeInteger(this.#totalBytes + data.byteLength)) {
      throw new RangeError("Decoded output exceeds the safe byte-offset range.");
    }
    this.#totalBytes += data.byteLength;
    this.#cachedText = undefined;
    const capacity = this.#storage.byteLength;
    if (data.byteLength >= capacity) {
      data.copy(this.#storage, 0, data.byteLength - capacity);
      this.#start = 0;
      this.#length = capacity;
    } else {
      const dropped = Math.max(0, this.#length + data.byteLength - capacity);
      this.#start = (this.#start + dropped) % capacity;
      this.#length -= dropped;
      const writeAt = (this.#start + this.#length) % capacity;
      const firstLength = Math.min(data.byteLength, capacity - writeAt);
      data.copy(this.#storage, writeAt, 0, firstLength);
      data.copy(this.#storage, 0, firstLength);
      this.#length += data.byteLength;
    }
    // Eviction may split a code point. Drop only its orphaned continuation bytes.
    while (this.#length > 0 && (this.#storage[this.#start]! & 0xc0) === 0x80) {
      this.#start = (this.#start + 1) % capacity;
      this.#length -= 1;
    }
    return true;
  }
}

export function outputRetention(
  stdout: BoundedOutputBuffer,
  stderr: BoundedOutputBuffer,
): OutputRetention {
  return { schemaVersion: OUTPUT_RETENTION_SCHEMA, stdout: stdout.range(), stderr: stderr.range() };
}

/** Old ledgers have no retention metadata and keep their original prefix offsets. */
export function runOutputRange(run: RunRecord, stream: "stdout" | "stderr"): OutputRange {
  const retainedBytes = Buffer.byteLength(run[stream], "utf8");
  const raw = run.metadata.outputRetention;
  if (raw === undefined) return { startOffset: 0, endOffset: retainedBytes };
  const invalid = (): never => {
    throw new RuntimeError("INTERNAL_ERROR", "Run output retention metadata is invalid.", 500);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const layout = raw as Partial<OutputRetention>;
  const range = layout[stream];
  if (
    layout.schemaVersion !== OUTPUT_RETENTION_SCHEMA ||
    range === null || typeof range !== "object" || Array.isArray(range) ||
    !Number.isSafeInteger(range.startOffset) || !Number.isSafeInteger(range.endOffset) ||
    range.startOffset < 0 || range.endOffset < range.startOffset ||
    range.endOffset - range.startOffset !== retainedBytes
  ) return invalid();
  return { startOffset: range.startOffset, endOffset: range.endOffset };
}
