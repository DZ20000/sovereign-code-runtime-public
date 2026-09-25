export interface PythonRuntimeSpec {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly launcher: string;
  readonly version: string;
  readonly implementation: string;
}

export type PythonProbeRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  timeoutMs: number,
  maxOutputBytes: number,
) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

function parsePythonProbe(output: string): { readonly version: string; readonly implementation: string } | null {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.version === "string" && typeof record.implementation === "string"
      ? { version: record.version, implementation: record.implementation }
      : null;
  } catch {
    return null;
  }
}

export async function discoverPythonRuntime(
  cwd: string,
  maxOutputBytes: number,
  runProbe: PythonProbeRunner,
): Promise<PythonRuntimeSpec | null> {
  const candidates: readonly {
    readonly command: string;
    readonly prefixArgs: readonly string[];
    readonly launcher: string;
  }[] = process.platform === "win32"
    ? [
        { command: "py", prefixArgs: ["-3"], launcher: "py -3" },
        { command: "python", prefixArgs: [], launcher: "python" },
        { command: "python3", prefixArgs: [], launcher: "python3" },
      ]
    : [
        { command: "python3", prefixArgs: [], launcher: "python3" },
        { command: "python", prefixArgs: [], launcher: "python" },
      ];
  const probe = [
    "import json, platform",
    "print(json.dumps({'version': platform.python_version(), 'implementation': platform.python_implementation()}, separators=(',', ':')))",
  ].join("; ");

  for (const candidate of candidates) {
    try {
      const result = await runProbe(
        candidate.command,
        [...candidate.prefixArgs, "-I", "-u", "-c", probe],
        cwd,
        `Python probe (${candidate.launcher})`,
        5_000,
        Math.min(maxOutputBytes, 32_768),
      );
      if (result.exitCode !== 0) continue;
      const metadata = parsePythonProbe(result.stdout);
      if (metadata !== null) {
        return { ...candidate, ...metadata };
      }
    } catch {
      // Try the next fixed interpreter candidate.
    }
  }
  return null;
}
