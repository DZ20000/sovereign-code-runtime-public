export const LIFECYCLE_REPORT_SCHEMA: "scr.lifecycle-benchmark/v1";
export const MIB: number;
export const LIFECYCLE_BUDGETS: Readonly<{
  idleGrowthRatio: number;
  viewSwitchBytes: number;
  terminalCloseBytes: number;
  browserCloseBytes: number;
  approvalBytes: number;
}>;

export interface LifecycleBenchmarkReport {
  readonly schemaVersion: "scr.lifecycle-benchmark/v1";
  readonly generatedAt: string | null;
  readonly scenarios: {
    readonly idle30m: {
      readonly beforePrivateBytes: number;
      readonly afterPrivateBytes: number;
    };
    readonly viewSwitch50: {
      readonly baselinePrivateBytes: number;
      readonly afterSettlePrivateBytes: number;
    };
    readonly terminalClose: {
      readonly preOpenPrivateBytes: number;
      readonly afterSettlePrivateBytes: number;
    };
    readonly browserClose: {
      readonly preOpenPrivateBytes: number;
      readonly afterSettlePrivateBytes: number;
    };
    readonly approval100: {
      readonly preRunPrivateBytes: number;
      readonly afterSettlePrivateBytes: number;
      readonly orphanWindowCount: number;
      readonly orphanRendererCount: number;
    };
  };
}

export interface LifecycleBudgetCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly growthRatio?: number;
  readonly maximumGrowthRatio?: number;
  readonly deltaBytes?: number;
  readonly maximumIncreaseBytes?: number;
  readonly orphanWindowCount?: number;
  readonly orphanRendererCount?: number;
}

export interface LifecycleBudgetResult {
  readonly schemaVersion: "scr.lifecycle-budget-result/v1";
  readonly passed: boolean;
  readonly sourceSchemaVersion: "scr.lifecycle-benchmark/v1";
  readonly checks: readonly LifecycleBudgetCheck[];
}

export function parseLifecycleBenchmarkReport(
  value: unknown,
): LifecycleBenchmarkReport;
export function evaluateLifecycleBenchmark(
  value: unknown,
): LifecycleBudgetResult;
export function runLifecycleBudgetCli(
  argv: readonly string[],
): Promise<LifecycleBudgetResult>;
