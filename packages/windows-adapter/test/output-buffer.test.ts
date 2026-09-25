import { StringDecoder } from "node:string_decoder";
import { describe, expect, it } from "vitest";
import { BoundedOutputBuffer } from "../src/output-buffer.js";

function expectedTail(text: string, capacity: number): { text: string; start: number; end: number } {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.max(0, bytes.length - capacity);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), start, end: bytes.length };
}

describe("bounded UTF-8 output", () => {
  it.each([4, 5, 7, 16, 63, 256])("retains a valid suffix across wraps with capacity %i", (capacity) => {
    const output = new BoundedOutputBuffer(capacity);
    const decoder = new StringDecoder("utf8");
    const source = Buffer.from("中文😀alpha\nβeta\n".repeat(60), "utf8");
    let decoded = "";
    let offset = 0;
    let step = 1;
    while (offset < source.length) {
      const size = 1 + ((step++ * 17) % 83);
      const chunk = source.subarray(offset, offset + size);
      output.append(chunk);
      decoded += decoder.write(chunk);
      const expected = expectedTail(decoded, capacity);
      expect(output.text()).toBe(expected.text);
      expect(output.range()).toEqual({ startOffset: expected.start, endOffset: expected.end });
      expect(Buffer.byteLength(output.text())).toBeLessThanOrEqual(capacity);
      expect(output.text()).not.toContain("\ufffd");
      offset += chunk.length;
    }
    output.finish();
    expect(output.text()).toBe(expectedTail(decoded + decoder.end(), capacity).text);
    expect(output.truncated()).toBe(true);
  });

  it("does not expose a partial multi-byte character before the next chunk", () => {
    const output = new BoundedOutputBuffer(32);
    const character = Buffer.from("😀");
    expect(output.append(character.subarray(0, 2))).toBe(false);
    expect(output.text()).toBe("");
    expect(output.range().endOffset).toBe(0);
    expect(output.append(character.subarray(2))).toBe(true);
    expect(output.text()).toBe("😀");
    expect(output.range()).toEqual({ startOffset: 0, endOffset: 4 });
  });

  it("flushes incomplete or invalid input deterministically at the end", () => {
    const output = new BoundedOutputBuffer(16);
    output.append(Buffer.from([0x61, 0xff, 0xe4, 0xb8]));
    expect(output.text()).toBe("a\ufffd");
    output.finish();
    expect(output.text()).toBe("a\ufffd\ufffd");
    expect(output.range().endOffset).toBe(7);
    output.finish();
    expect(output.text()).toBe("a\ufffd\ufffd");
    expect(() => output.append(Buffer.from("late"))).toThrow(/finished/u);
  });

  it("owns its storage rather than retaining mutable caller buffers", () => {
    const output = new BoundedOutputBuffer(16);
    const chunk = Buffer.from("hello");
    output.append(chunk);
    chunk.fill(0);
    expect(output.text()).toBe("hello");
    expect(output.truncated()).toBe(false);
  });

  it("keeps the final diagnostic after a finite no-newline flood", () => {
    const output = new BoundedOutputBuffer(1024);
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let i = 0; i < 256; i += 1) output.append(chunk);
    output.append(Buffer.from("\n最终错误: END_MARKER\n"));
    output.finish();
    expect(output.text()).toContain("最终错误: END_MARKER");
    expect(Buffer.byteLength(output.text())).toBeLessThanOrEqual(1024);
    expect(output.range().endOffset).toBe(16 * 1024 * 1024 + Buffer.byteLength("\n最终错误: END_MARKER\n"));
    expect(output.range().startOffset).toBeGreaterThan(0);
  });

  it.each([0, 3, -1, 4.5, NaN, Infinity, 67_108_865])("rejects invalid capacity %s", (capacity) => {
    expect(() => new BoundedOutputBuffer(capacity)).toThrow(RangeError);
  });
});
