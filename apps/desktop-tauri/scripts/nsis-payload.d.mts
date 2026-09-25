export interface NsisPayloadDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export function resolveSevenZipExecutable(
  environment?: NodeJS.ProcessEnv,
): Promise<string>;

export function extractNsisPayloadDescriptor(options: {
  readonly installerPath: string;
  readonly payloadPath: string;
  readonly extractorExecutable?: string;
  readonly extractorArgumentsPrefix?: readonly string[];
  readonly extractorEnvironment?: NodeJS.ProcessEnv;
}): Promise<NsisPayloadDescriptor>;
