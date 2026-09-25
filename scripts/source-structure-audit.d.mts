export type SourceStructureFindingSeverity = "warning" | "error";

export interface SourceStructureFinding {
  readonly severity: SourceStructureFindingSeverity;
  readonly code: string;
  readonly path: string;
  readonly lines: number | null;
  readonly limit: number | null;
}

export interface SourceStructureFileSummary {
  readonly path: string;
  readonly lines: number;
  readonly bytes: number;
  readonly baseline: boolean;
  readonly limit: number;
}

export interface SourceStructureAuditReport {
  readonly schemaVersion: "scr.source-structure-audit/v1";
  readonly generatedAt: string;
  readonly root: string;
  readonly gitHead: string;
  readonly config: {
    readonly path: string;
    readonly baselinePath: string;
    readonly recommendedMaxLines: number;
    readonly hardMaxLines: number;
    readonly maximumSourceBytes: number;
  };
  readonly baseline: {
    readonly generatedFromHead: string;
    readonly entryCount: number;
    readonly policy: string;
  };
  readonly summary: {
    readonly fileCount: number;
    readonly totalLines: number;
    readonly errorCount: number;
    readonly warningCount: number;
    readonly passed: boolean;
  };
  readonly findings: readonly SourceStructureFinding[];
  readonly largestFiles: readonly SourceStructureFileSummary[];
}

export interface SourceStructureAuditOptions {
  readonly root: string;
  readonly configPath?: string;
}

export interface SourceStructureCliOptions {
  readonly root: string;
  readonly configPath: string;
  readonly output: string | null;
  readonly check: boolean;
}

export const SOURCE_STRUCTURE_AUDIT_SCHEMA_VERSION: string;
export const SOURCE_STRUCTURE_CONFIG_SCHEMA_VERSION: string;
export const SOURCE_STRUCTURE_BASELINE_SCHEMA_VERSION: string;

export function auditSourceStructure(
  options: SourceStructureAuditOptions,
): Promise<SourceStructureAuditReport>;

export function parseSourceStructureCliArguments(
  argv: readonly string[],
): SourceStructureCliOptions;

export function runSourceStructureAuditCli(
  argv: readonly string[],
): Promise<SourceStructureAuditReport>;
