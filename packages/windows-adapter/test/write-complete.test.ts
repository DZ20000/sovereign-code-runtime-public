import { describe, expect, it, vi } from "vitest";
import { writeAllAtStart } from "../src/write-complete.js";

describe("complete positional writes", () => {
  it("advances both buffer and file positions by the actual written count", async () => {
    const data = Buffer.from("abcdefg");
    const stored = Buffer.alloc(data.length);
    const write = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesWritten = Math.min(2, length);
      buffer.copy(stored, position, offset, offset + bytesWritten);
      return { bytesWritten };
    });
    await writeAllAtStart({ write }, data);
    expect(stored).toEqual(data);
    expect(write.mock.calls.map(([, offset, length, position]) => [offset, length, position])).toEqual([
      [0, 7, 0], [2, 5, 2], [4, 3, 4], [6, 1, 6],
    ]);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 4])("rejects invalid progress %s without retrying", async (bytesWritten) => {
    const write = vi.fn(async () => ({ bytesWritten }));
    await expect(writeAllAtStart({ write }, Buffer.from("abc"))).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("propagates the original error after partial progress", async () => {
    const error = Object.assign(new Error("Synthetic disk full"), { code: "ENOSPC" });
    const write = vi.fn()
      .mockResolvedValueOnce({ bytesWritten: 1 })
      .mockRejectedValueOnce(error);
    await expect(writeAllAtStart({ write }, Buffer.from("abc"))).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not issue an empty write", async () => {
    const write = vi.fn(async () => ({ bytesWritten: 0 }));
    await writeAllAtStart({ write }, Buffer.alloc(0));
    expect(write).not.toHaveBeenCalled();
  });
});
