import { describe, expect, it } from "vitest";

import {
  taskDetailFailureDisposition,
  taskRefreshFailureDisposition,
} from "../src/renderer/task-refresh-failure-policy.js";

describe("task refresh failure policy", () => {
  it("propagates background failures without producing polling toast noise", () => {
    expect(taskRefreshFailureDisposition("background", false)).toEqual({
      notify: false,
      propagate: true,
    });
    expect(taskDetailFailureDisposition("background", false)).toEqual({
      notify: false,
      propagate: true,
    });
  });

  it("upgrades an in-flight background refresh when the user requests it", () => {
    expect(taskRefreshFailureDisposition("background", true)).toEqual({
      notify: true,
      propagate: true,
    });
    expect(taskRefreshFailureDisposition("manual", false)).toEqual({
      notify: true,
      propagate: true,
    });
    expect(taskDetailFailureDisposition("manual", false)).toEqual({
      notify: false,
      propagate: true,
    });
  });

  it("lets direct navigation failures notify without rejecting the click path", () => {
    expect(taskDetailFailureDisposition(null, true)).toEqual({
      notify: true,
      propagate: false,
    });
    expect(taskDetailFailureDisposition(null, false)).toEqual({
      notify: false,
      propagate: false,
    });
  });
});
