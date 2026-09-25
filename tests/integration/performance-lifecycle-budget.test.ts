import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_BUDGETS,
  MIB,
  evaluateLifecycleBenchmark,
  parseLifecycleBenchmarkReport,
} from "../../scripts/performance-lifecycle-budget.mjs";

function report() {
  const baseline = 200 * MIB;
  return {
    schemaVersion: "scr.lifecycle-benchmark/v1",
    generatedAt: "2026-08-29T00:00:00Z",
    scenarios: {
      idle30m: {
        beforePrivateBytes: baseline,
        afterPrivateBytes: baseline + 20 * MIB,
      },
      viewSwitch50: {
        baselinePrivateBytes: baseline,
        afterSettlePrivateBytes: baseline + 15 * MIB,
      },
      terminalClose: {
        preOpenPrivateBytes: baseline,
        afterSettlePrivateBytes: baseline + 10 * MIB,
      },
      browserClose: {
        preOpenPrivateBytes: baseline,
        afterSettlePrivateBytes: baseline + 30 * MIB,
      },
      approval100: {
        preRunPrivateBytes: baseline,
        afterSettlePrivateBytes: baseline + 15 * MIB,
        orphanWindowCount: 0,
        orphanRendererCount: 0,
      },
    },
  };
}

describe("desktop lifecycle performance budget", () => {
  it("accepts each documented boundary exactly", () => {
    const result = evaluateLifecycleBenchmark(report());
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails each memory budget above its documented limit", () => {
    const cases: Array<[string, (value: ReturnType<typeof report>) => void]> = [
      [
        "idle30m",
        (value) => {
          value.scenarios.idle30m.afterPrivateBytes += 1;
        },
      ],
      [
        "viewSwitch50",
        (value) => {
          value.scenarios.viewSwitch50.afterSettlePrivateBytes += 1;
        },
      ],
      [
        "terminalClose",
        (value) => {
          value.scenarios.terminalClose.afterSettlePrivateBytes += 1;
        },
      ],
      [
        "browserClose",
        (value) => {
          value.scenarios.browserClose.afterSettlePrivateBytes += 1;
        },
      ],
      [
        "approval100",
        (value) => {
          value.scenarios.approval100.afterSettlePrivateBytes += 1;
        },
      ],
    ];
    for (const [id, mutate] of cases) {
      const value = report();
      mutate(value);
      const result = evaluateLifecycleBenchmark(value);
      expect(result.passed, id).toBe(false);
      expect(result.checks.find((check) => check.id === id)?.passed, id).toBe(
        false,
      );
    }
  });

  it("fails approval lifecycle when any orphan UI process remains", () => {
    for (const field of ["orphanWindowCount", "orphanRendererCount"] as const) {
      const value = report();
      value.scenarios.approval100[field] = 1;
      const result = evaluateLifecycleBenchmark(value);
      expect(result.passed).toBe(false);
      expect(
        result.checks.find((check) => check.id === "approval100")?.passed,
      ).toBe(false);
    }
  });

  it("rejects malformed and unsafe numeric evidence", () => {
    expect(() =>
      parseLifecycleBenchmarkReport({ ...report(), schemaVersion: "wrong" }),
    ).toThrow(/Unsupported/u);
    const zero = report();
    zero.scenarios.idle30m.beforePrivateBytes = 0;
    expect(() => evaluateLifecycleBenchmark(zero)).toThrow(
      /greater than zero/u,
    );
    const unsafe = report();
    unsafe.scenarios.browserClose.afterSettlePrivateBytes =
      Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseLifecycleBenchmarkReport(unsafe)).toThrow(
      /safe integer/u,
    );
  });

  it("keeps the checked limits tied to the published budget", () => {
    expect(LIFECYCLE_BUDGETS).toEqual({
      idleGrowthRatio: 0.1,
      viewSwitchBytes: 15 * MIB,
      terminalCloseBytes: 10 * MIB,
      browserCloseBytes: 30 * MIB,
      approvalBytes: 15 * MIB,
    });
  });
});
