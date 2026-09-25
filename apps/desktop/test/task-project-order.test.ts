import { describe, expect, it } from "vitest";
import { compareTaskProjectFallback } from "../src/renderer/task-project-order.js";
function project(id: string, name: string, updatedAt: string) {
  return { id, name, updatedAt };
}
describe("task project fallback ordering", () => {
  it("sorts valid update times newest first", () => {
    const values = [
      project("older", "Older", "2026-08-29T00:00:00.000Z"),
      project("newer", "Newer", "2026-08-29T01:00:00.000Z"),
    ];
    expect(
      [...values].sort(compareTaskProjectFallback).map((value) => value.id),
    ).toEqual(["newer", "older"]);
  });
  it("treats invalid timestamps deterministically", () => {
    const values = [
      project("z", "Zulu", "invalid"),
      project("a", "Alpha", "also-invalid"),
    ];
    expect(
      [...values].sort(compareTaskProjectFallback).map((value) => value.id),
    ).toEqual(["a", "z"]);
  });
  it("uses project name before identity when timestamps tie", () => {
    const timestamp = "2026-08-29T00:00:00.000Z";
    const values = [
      project("a", "Zulu", timestamp),
      project("z", "Alpha", timestamp),
    ];
    expect(
      [...values].sort(compareTaskProjectFallback).map((value) => value.name),
    ).toEqual(["Alpha", "Zulu"]);
  });
});
