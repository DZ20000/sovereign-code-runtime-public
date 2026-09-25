import { describe, expect, it } from "vitest";
import { validateTaskMessageOrder } from "../src/renderer/task-message-list.js";
describe("task message order preflight", () => {
  it("accepts a truncated conversation whose sequence starts above one", () => {
    expect(() =>
      validateTaskMessageOrder([
        { id: "message-8", sequence: 8 },
        { id: "message-9", sequence: 9 },
      ]),
    ).not.toThrow();
  });
  it("rejects duplicate message identities before reconciliation", () => {
    expect(() =>
      validateTaskMessageOrder([
        { id: "message", sequence: 1 },
        { id: "message", sequence: 2 },
      ]),
    ).toThrow("duplicated message message");
  });
  it("rejects duplicate or descending sequence values", () => {
    expect(() =>
      validateTaskMessageOrder([
        { id: "a", sequence: 2 },
        { id: "b", sequence: 2 },
      ]),
    ).toThrow("increase strictly");
    expect(() =>
      validateTaskMessageOrder([
        { id: "a", sequence: 2 },
        { id: "b", sequence: 1 },
      ]),
    ).toThrow("increase strictly");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid sequence %s",
    (sequence) => {
      expect(() =>
        validateTaskMessageOrder([{ id: "message", sequence }]),
      ).toThrow("invalid sequence number");
    },
  );
});
