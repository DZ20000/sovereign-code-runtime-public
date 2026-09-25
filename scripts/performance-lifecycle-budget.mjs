#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LIFECYCLE_REPORT_SCHEMA = "scr.lifecycle-benchmark/v1";
export const MIB = 1024 * 1024;
export const LIFECYCLE_BUDGETS = Object.freeze({
  idleGrowthRatio: 0.1,
  viewSwitchBytes: 15 * MIB,
  terminalCloseBytes: 10 * MIB,
  browserCloseBytes: 30 * MIB,
  approvalBytes: 15 * MIB,
});

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function requireBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer byte count.`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer count.`);
  }
  return value;
}

function deltaCheck(id, before, after, maximumIncreaseBytes) {
  const deltaBytes = after - before;
  return Object.freeze({
    id,
    passed: deltaBytes <= maximumIncreaseBytes,
    beforeBytes: before,
    afterBytes: after,
    deltaBytes,
    maximumIncreaseBytes,
  });
}

export function parseLifecycleBenchmarkReport(value) {
  const root = requireObject(value, "Lifecycle benchmark report");
  if (root.schemaVersion !== LIFECYCLE_REPORT_SCHEMA) {
    fail(
      `Unsupported lifecycle benchmark schema: ${String(root.schemaVersion)}.`,
    );
  }
  const scenarios = requireObject(
    root.scenarios,
    "Lifecycle benchmark scenarios",
  );
  const idle = requireObject(scenarios.idle30m, "idle30m");
  const views = requireObject(scenarios.viewSwitch50, "viewSwitch50");
  const terminal = requireObject(scenarios.terminalClose, "terminalClose");
  const browser = requireObject(scenarios.browserClose, "browserClose");
  const approval = requireObject(scenarios.approval100, "approval100");
  return Object.freeze({
    schemaVersion: LIFECYCLE_REPORT_SCHEMA,
    generatedAt: typeof root.generatedAt === "string" ? root.generatedAt : null,
    scenarios: Object.freeze({
      idle30m: Object.freeze({
        beforePrivateBytes: requireBytes(
          idle.beforePrivateBytes,
          "idle30m.beforePrivateBytes",
        ),
        afterPrivateBytes: requireBytes(
          idle.afterPrivateBytes,
          "idle30m.afterPrivateBytes",
        ),
      }),
      viewSwitch50: Object.freeze({
        baselinePrivateBytes: requireBytes(
          views.baselinePrivateBytes,
          "viewSwitch50.baselinePrivateBytes",
        ),
        afterSettlePrivateBytes: requireBytes(
          views.afterSettlePrivateBytes,
          "viewSwitch50.afterSettlePrivateBytes",
        ),
      }),
      terminalClose: Object.freeze({
        preOpenPrivateBytes: requireBytes(
          terminal.preOpenPrivateBytes,
          "terminalClose.preOpenPrivateBytes",
        ),
        afterSettlePrivateBytes: requireBytes(
          terminal.afterSettlePrivateBytes,
          "terminalClose.afterSettlePrivateBytes",
        ),
      }),
      browserClose: Object.freeze({
        preOpenPrivateBytes: requireBytes(
          browser.preOpenPrivateBytes,
          "browserClose.preOpenPrivateBytes",
        ),
        afterSettlePrivateBytes: requireBytes(
          browser.afterSettlePrivateBytes,
          "browserClose.afterSettlePrivateBytes",
        ),
      }),
      approval100: Object.freeze({
        preRunPrivateBytes: requireBytes(
          approval.preRunPrivateBytes,
          "approval100.preRunPrivateBytes",
        ),
        afterSettlePrivateBytes: requireBytes(
          approval.afterSettlePrivateBytes,
          "approval100.afterSettlePrivateBytes",
        ),
        orphanWindowCount: requireCount(
          approval.orphanWindowCount,
          "approval100.orphanWindowCount",
        ),
        orphanRendererCount: requireCount(
          approval.orphanRendererCount,
          "approval100.orphanRendererCount",
        ),
      }),
    }),
  });
}

export function evaluateLifecycleBenchmark(reportInput) {
  const report = parseLifecycleBenchmarkReport(reportInput);
  const { idle30m, viewSwitch50, terminalClose, browserClose, approval100 } =
    report.scenarios;
  if (idle30m.beforePrivateBytes === 0) {
    fail(
      "idle30m.beforePrivateBytes must be greater than zero for ratio evaluation.",
    );
  }
  const idleGrowthRatio =
    (idle30m.afterPrivateBytes - idle30m.beforePrivateBytes) /
    idle30m.beforePrivateBytes;
  const checks = [
    Object.freeze({
      id: "idle30m",
      passed: idleGrowthRatio <= LIFECYCLE_BUDGETS.idleGrowthRatio,
      beforeBytes: idle30m.beforePrivateBytes,
      afterBytes: idle30m.afterPrivateBytes,
      growthRatio: idleGrowthRatio,
      maximumGrowthRatio: LIFECYCLE_BUDGETS.idleGrowthRatio,
    }),
    deltaCheck(
      "viewSwitch50",
      viewSwitch50.baselinePrivateBytes,
      viewSwitch50.afterSettlePrivateBytes,
      LIFECYCLE_BUDGETS.viewSwitchBytes,
    ),
    deltaCheck(
      "terminalClose",
      terminalClose.preOpenPrivateBytes,
      terminalClose.afterSettlePrivateBytes,
      LIFECYCLE_BUDGETS.terminalCloseBytes,
    ),
    deltaCheck(
      "browserClose",
      browserClose.preOpenPrivateBytes,
      browserClose.afterSettlePrivateBytes,
      LIFECYCLE_BUDGETS.browserCloseBytes,
    ),
    Object.freeze({
      ...deltaCheck(
        "approval100",
        approval100.preRunPrivateBytes,
        approval100.afterSettlePrivateBytes,
        LIFECYCLE_BUDGETS.approvalBytes,
      ),
      orphanWindowCount: approval100.orphanWindowCount,
      orphanRendererCount: approval100.orphanRendererCount,
      passed:
        approval100.afterSettlePrivateBytes - approval100.preRunPrivateBytes <=
          LIFECYCLE_BUDGETS.approvalBytes &&
        approval100.orphanWindowCount === 0 &&
        approval100.orphanRendererCount === 0,
    }),
  ];
  return Object.freeze({
    schemaVersion: "scr.lifecycle-budget-result/v1",
    passed: checks.every((check) => check.passed),
    sourceSchemaVersion: report.schemaVersion,
    checks: Object.freeze(checks),
  });
}

export async function runLifecycleBudgetCli(argv) {
  if (argv.length !== 1 || argv[0]?.startsWith("-") === true) {
    fail("Usage: performance-lifecycle-budget.mjs <lifecycle-report.json>");
  }
  const path = resolve(argv[0]);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const result = evaluateLifecycleBenchmark(parsed);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
  return result;
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invoked !== null && import.meta.url === invoked) {
  runLifecycleBudgetCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
