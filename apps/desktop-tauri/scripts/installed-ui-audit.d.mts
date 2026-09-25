export interface InstalledUiAuditOptions {
  readonly executablePath: string | null;
  readonly identifier: string;
  readonly expectedProcessId: number | null;
  readonly expectedReleaseId: string | null;
  readonly expectedVersion: string | null;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
  readonly maxAccessibilityElements: number;
  readonly captureScreenshot: boolean;
  readonly strict: boolean;
}

export interface InstalledUiAuditAssessment {
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly passed: boolean;
}

export interface InstalledUiAuditDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly runPowerShell?: (script: string, timeoutMs?: number) => string;
  readonly readRendererState?: (options: {
    readonly appDataPath: string;
    readonly identifier: string;
    readonly trustedKeysPath: string;
  }) => Promise<unknown>;
}

export const INSTALLED_UI_AUDIT_SCHEMA_VERSION: "scr.installed-ui-audit/v1";
export const DEFAULT_INSTALLED_UI_IDENTIFIER: "com.sovereign.runtime";
export const DEFAULT_INSTALLED_UI_PRODUCT_NAME: "Sovereign Code Runtime";
export const MAX_INSTALLED_UI_SCREENSHOT_BYTES: number;

export function parseInstalledUiAuditArguments(
  argv: readonly string[],
): InstalledUiAuditOptions;

export function assessInstalledUiAudit(options: {
  readonly observation: any;
  readonly renderer: any;
  readonly expectedProcessId: number | null;
  readonly expectedReleaseId: string | null;
  readonly expectedVersion: string | null;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
  readonly captureScreenshot: boolean;
  readonly strict: boolean;
}): InstalledUiAuditAssessment;

export function runInstalledUiAudit(
  options: InstalledUiAuditOptions,
  dependencies?: InstalledUiAuditDependencies,
): Promise<any>;

export function runInstalledUiAuditCli(argv: readonly string[]): Promise<any>;
