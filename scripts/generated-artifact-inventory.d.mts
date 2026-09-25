export type GeneratedArtifactKind = "file" | "directory" | "link" | "other";
export type GeneratedArtifactDisposition =
  "eligible-after-process-check" | "review" | "blocked";

export interface GeneratedArtifactEntry {
  readonly relativePath: string;
  readonly kind: GeneratedArtifactKind;
  readonly category: string;
  readonly gitIgnored: boolean;
  readonly trackedFileCount: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly linkCount: number;
  readonly byteCount: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly disposition: GeneratedArtifactDisposition;
  readonly risk: string;
  readonly automatedDeletionAllowed: false;
}

export interface GeneratedArtifactInventory {
  readonly schemaVersion: "scr.generated-artifact-inventory/v1";
  readonly generatedAt: string;
  readonly root: string;
  readonly gitHead: string;
  readonly readOnly: true;
  readonly automatedDeletionAllowed: false;
  readonly summary: {
    readonly candidateCount: number;
    readonly eligibleCount: number;
    readonly reviewCount: number;
    readonly blockedCount: number;
    readonly observedBytes: number;
    readonly complete: boolean;
    readonly discoveryTruncated: boolean;
    readonly scannedEntryCount: number;
    readonly maximumEntries: number;
  };
  readonly entries: readonly GeneratedArtifactEntry[];
}

export interface GeneratedArtifactInventoryOptions {
  readonly root: string;
  readonly maximumEntries?: number;
}

export interface GeneratedArtifactCliOptions {
  readonly root: string;
  readonly output: string | null;
  readonly maximumEntries: number;
}

export const GENERATED_ARTIFACT_INVENTORY_SCHEMA_VERSION: string;

export function collectGeneratedArtifacts(
  options: GeneratedArtifactInventoryOptions,
): Promise<GeneratedArtifactInventory>;

export function parseGeneratedArtifactCliArguments(
  argv: readonly string[],
): GeneratedArtifactCliOptions;

export function runGeneratedArtifactInventoryCli(
  argv: readonly string[],
): Promise<GeneratedArtifactInventory>;
