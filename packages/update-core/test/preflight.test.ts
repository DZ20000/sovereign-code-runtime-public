import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CandidatePreflightError,
  canonicalReleaseJson,
  materializeCandidateSlot,
  parseReleaseManifest,
  releaseSha256,
  releaseSignaturePayload,
  runCandidatePreflight,
  type CandidatePayloadSource,
  type CandidatePreflightProcessLauncher,
  type CandidatePreflightProcessRequest,
  type ReleaseComponent,
  type ReleaseManifest,
  type ReleaseSignatureEnvelope,
  type TrustedReleasePublicKey,
} from "../src/index.js";

const cleanupPaths: string[] = [];
const payload = new Map<string, Buffer>([
  ["SovereignCodeRuntime.exe", Buffer.from("candidate shell", "utf8")],
  ["runtime-host.cjs", Buffer.from("candidate runtime host", "utf8")],
  ["node/node.exe", Buffer.from("candidate node", "utf8")],
  ["host-guardian.mjs", Buffer.from("candidate guardian", "utf8")],
  ["runtime-manifest.json", Buffer.from('{"schemaVersion":"test"}', "utf8")],
  ["native/bin/SovereignNativeAgent.exe", Buffer.from("candidate native agent", "utf8")],
]);

class MemoryPayloadSource implements CandidatePayloadSource {
  async listComponents(): Promise<readonly string[]> {
    return [...payload.keys()];
  }

  async openComponent(componentPath: string): Promise<AsyncIterable<Uint8Array>> {
    const bytes = payload.get(componentPath);
    if (bytes === undefined) throw new Error(`missing component: ${componentPath}`);
    return (async function* (): AsyncGenerator<Uint8Array> {
      yield bytes;
    })();
  }
}

function component(
  path: string,
  role: ReleaseComponent["role"],
): ReleaseComponent {
  const bytes = payload.get(path)!;
  return {
    path,
    role,
    bytes: bytes.byteLength,
    sha256: releaseSha256(bytes),
  };
}

function releaseManifest(): ReleaseManifest {
  const components = [
    component("SovereignCodeRuntime.exe", "shell"),
    component("runtime-host.cjs", "runtime-host"),
    component("node/node.exe", "node"),
    component("host-guardian.mjs", "host-guardian"),
    component("runtime-manifest.json", "resource"),
    component("native/bin/SovereignNativeAgent.exe", "native-agent"),
  ];
  return parseReleaseManifest({
    schemaVersion: "scr.release/v1",
    releaseId: "release-0002",
    releaseSequence: 2,
    version: "0.2.0",
    channel: "stable",
    createdAt: "2026-08-20T00:00:00.000Z",
    entrypoint: "SovereignCodeRuntime.exe",
    totalBytes: components.reduce((sum, entry) => sum + entry.bytes, 0),
    components,
    compatibility: {
      minimumBootstrapVersion: "0.1.0",
      maximumBootstrapVersion: "0.9.0",
      runtimeHostProtocolVersion: 1,
      preCommitDataPolicy: "backward-compatible",
      dataSchemas: {
        settings: { readableMin: 1, readableMax: 1, writeVersion: 1 },
        audit: { readableMin: 1, readableMax: 1, writeVersion: 1 },
        runs: { readableMin: 1, readableMax: 1, writeVersion: 1 },
      },
    },
  });
}

function trustedKey(publicKey: KeyObject): TrustedReleasePublicKey {
  return {
    keyId: "release-key-1",
    algorithm: "ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    minimumReleaseSequence: 1,
    maximumReleaseSequence: null,
    allowedChannels: ["stable"],
  };
}

function signedEnvelope(
  privateKey: KeyObject,
  manifest = releaseManifest(),
): ReleaseSignatureEnvelope {
  const manifestSha256 = releaseSha256(canonicalReleaseJson(manifest));
  return {
    schemaVersion: "scr.release-signature/v1",
    algorithm: "ed25519",
    keyId: "release-key-1",
    manifestSha256,
    signature: sign(
      null,
      releaseSignaturePayload(manifestSha256),
      privateKey,
    ).toString("base64url"),
    manifest,
  };
}

interface ReadyCandidate {
  readonly root: string;
  readonly slots: string;
  readonly isolated: string;
  readonly trustedKeys: readonly TrustedReleasePublicKey[];
  readonly manifest: ReleaseManifest;
  readonly manifestSha256: string;
}

async function createReadyCandidate(): Promise<ReadyCandidate> {
  const root = await mkdtemp(join(tmpdir(), "scr-preflight-test-"));
  cleanupPaths.push(root);
  const slots = join(root, "slots");
  const isolated = join(root, "isolated");
  await Promise.all([mkdir(slots), mkdir(isolated)]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = releaseManifest();
  const envelope = signedEnvelope(privateKey, manifest);
  await materializeCandidateSlot({
    slotsDirectory: slots,
    signedEnvelope: envelope,
    trustedKeys: [trustedKey(publicKey)],
    source: new MemoryPayloadSource(),
  });
  return {
    root,
    slots,
    isolated,
    trustedKeys: [trustedKey(publicKey)],
    manifest,
    manifestSha256: envelope.manifestSha256,
  };
}

interface ReportOverrides {
  readonly releaseId?: string;
  readonly releaseSequence?: number;
  readonly manifestSha256?: string;
  readonly executablePath?: string;
  readonly runtimeHostProtocolVersion?: number;
  readonly runtimeVersion?: string;
  readonly endpoint?: string;
  readonly desiredRunning?: boolean;
  readonly processId?: number | null;
  readonly hasRuntimeApiKey?: boolean;
  readonly tunnelId?: string | null;
  readonly includeGuardian?: boolean;
  readonly ok?: boolean;
  readonly updatePreflightError?: string | null;
}

function validReport(
  request: CandidatePreflightProcessRequest,
  overrides: ReportOverrides = {},
): unknown {
  const environment = request.environment;
  const releaseId = overrides.releaseId ?? environment.SCR_UPDATE_PREFLIGHT_RELEASE_ID;
  const releaseSequence = overrides.releaseSequence ??
    Number(environment.SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE);
  const manifestSha256 = overrides.manifestSha256 ??
    environment.SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256;
  const runtimeVersion = overrides.runtimeVersion ?? "0.2.0";
  const roles = ["desktop-main", "runtime-host"];
  if (overrides.includeGuardian !== false) roles.push("host-guardian");
  return {
    schemaVersion: "scr.tauri-smoke/v1",
    ok: overrides.ok ?? true,
    uiReady: true,
    ui: {
      href: "http://tauri.localhost/",
      title: "Sovereign Code Runtime",
      readyState: "complete",
      appChildCount: 1,
    },
    state: {
      phase: "running",
      runtimeVersion,
      endpoint: overrides.endpoint ?? "http://127.0.0.1:3210/mcp",
      toolCount: 2,
      secureTunnel: {
        desiredRunning: overrides.desiredRunning ?? false,
        processId: overrides.processId ?? null,
        hasRuntimeApiKey: overrides.hasRuntimeApiKey ?? false,
        tunnelId: overrides.tunnelId ?? null,
      },
    },
    manifest: {
      runtimeVersion,
      tools: [{ name: "system.info" }, { name: "workspace.list" }],
    },
    resources: {
      processes: roles.map((role, index) => ({ role, processId: index + 1 })),
      totals: { productPrivateBytes: 1_024 },
    },
    availability: {
      schemaVersion: "scr.host-availability/v1",
      available: true,
      sampledAt: "2026-08-20T00:00:01.000Z",
      systemUptimeMs: 10_000,
    },
    updatePreflight: {
      schemaVersion: "scr.update-preflight-evidence/v1",
      releaseId,
      releaseSequence,
      manifestSha256,
      executablePath: overrides.executablePath ?? request.executablePath,
      runtimeHostProtocolVersion: overrides.runtimeHostProtocolVersion ?? 1,
    },
    updatePreflightError: overrides.updatePreflightError ?? null,
  };
}

class ReportLauncher implements CandidatePreflightProcessLauncher {
  readonly #overrides: ReportOverrides;
  readonly requests: CandidatePreflightProcessRequest[] = [];

  constructor(overrides: ReportOverrides = {}) {
    this.#overrides = overrides;
  }

  async launch(request: CandidatePreflightProcessRequest) {
    this.requests.push(request);
    const reportPath = request.environment.SCR_SMOKE_REPORT_PATH;
    if (reportPath === undefined) throw new Error("missing smoke report path");
    await writeFile(
      reportPath,
      `${JSON.stringify(validReport(request, this.#overrides), null, 2)}\n`,
      "utf8",
    );
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false } as const;
  }
}

async function expectPreflightCode(
  operation: () => Promise<unknown>,
  code: CandidatePreflightError["code"],
): Promise<CandidatePreflightError> {
  try {
    await operation();
    throw new Error(`Expected CandidatePreflightError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidatePreflightError);
    expect((error as CandidatePreflightError).code).toBe(code);
    return error as CandidatePreflightError;
  }
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("candidate packaged preflight", () => {
  it("runs a verified candidate in an isolated environment and returns bounded evidence", async () => {
    const candidate = await createReadyCandidate();
    const launcher = new ReportLauncher();
    const result = await runCandidatePreflight({
      slotsDirectory: candidate.slots,
      releaseId: candidate.manifest.releaseId,
      trustedKeys: candidate.trustedKeys,
      isolatedRootDirectory: candidate.isolated,
      launcher,
    });

    expect(result).toMatchObject({
      schemaVersion: "scr.candidate-preflight/v1",
      releaseId: "release-0002",
      releaseSequence: 2,
      version: "0.2.0",
      channel: "stable",
      manifestSha256: candidate.manifestSha256,
      exitCode: 0,
      signal: null,
      reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reportBytes: expect.any(Number),
      checks: Object.fromEntries(
        Object.keys(result.checks).map((key) => [key, true]),
      ),
      artifactsDirectory: null,
    });
    expect(result.reportBytes).toBeGreaterThan(0);
    expect(result.reportBytes).toBeLessThan(2 * 1024 * 1024);
    expect(launcher.requests).toHaveLength(1);
    const request = launcher.requests[0]!;
    expect(request.environment).toMatchObject({
      SCR_UPDATE_PREFLIGHT: "1",
      SCR_UPDATE_PREFLIGHT_RELEASE_ID: "release-0002",
      SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE: "2",
      SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256: candidate.manifestSha256,
      SCR_RUN_COMPLETION_NOTIFICATIONS: "0",
    });
    expect(request.environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(request.environment).not.toHaveProperty("SCR_TUNNEL_RUNTIME_API_KEY");
    expect(request.environment.APPDATA).not.toBe(process.env.APPDATA);
    expect(await readdir(candidate.isolated)).toEqual([]);
  });

  it("rejects mismatched release identity without exposing the raw report", async () => {
    const candidate = await createReadyCandidate();
    const launcher = new ReportLauncher({ releaseId: "release-9999" });
    const error = await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: candidate.slots,
        releaseId: candidate.manifest.releaseId,
        trustedKeys: candidate.trustedKeys,
        isolatedRootDirectory: candidate.isolated,
        launcher,
      }),
      "CANDIDATE_FAILED",
    );

    expect(error.checks).toMatchObject({
      identityMatched: false,
      executableMatched: true,
    });
    expect(JSON.stringify(error)).not.toContain("release-9999");
    expect(await readdir(candidate.isolated)).toEqual([]);
  });

  it("rejects protocol, guardian, and tunnel isolation failures", async () => {
    for (const overrides of [
      { runtimeHostProtocolVersion: 2 },
      { includeGuardian: false },
      { desiredRunning: true },
      { processId: 42 },
      { hasRuntimeApiKey: true },
      { tunnelId: "tunnel_test" },
      { updatePreflightError: "invalid candidate metadata" },
    ] satisfies ReportOverrides[]) {
      const candidate = await createReadyCandidate();
      await expectPreflightCode(
        () => runCandidatePreflight({
          slotsDirectory: candidate.slots,
          releaseId: candidate.manifest.releaseId,
          trustedKeys: candidate.trustedKeys,
          isolatedRootDirectory: candidate.isolated,
          launcher: new ReportLauncher(overrides),
        }),
        "CANDIDATE_FAILED",
      );
    }
  });

  it("classifies timeout and cancellation before report parsing", async () => {
    const candidate = await createReadyCandidate();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: candidate.slots,
        releaseId: candidate.manifest.releaseId,
        trustedKeys: candidate.trustedKeys,
        isolatedRootDirectory: candidate.isolated,
        launcher: {
          launch: async () => ({
            exitCode: null,
            signal: null,
            timedOut: true,
            cancelled: false,
          }),
        },
      }),
      "TIMEOUT",
    );

    const second = await createReadyCandidate();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: second.slots,
        releaseId: second.manifest.releaseId,
        trustedKeys: second.trustedKeys,
        isolatedRootDirectory: second.isolated,
        launcher: {
          launch: async () => ({
            exitCode: null,
            signal: null,
            timedOut: false,
            cancelled: true,
          }),
        },
      }),
      "CANCELLED",
    );
  });

  it("rejects a missing, oversized, or multiply linked report", async () => {
    const missing = await createReadyCandidate();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: missing.slots,
        releaseId: missing.manifest.releaseId,
        trustedKeys: missing.trustedKeys,
        isolatedRootDirectory: missing.isolated,
        launcher: {
          launch: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
          }),
        },
      }),
      "REPORT_MISSING",
    );

    const oversized = await createReadyCandidate();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: oversized.slots,
        releaseId: oversized.manifest.releaseId,
        trustedKeys: oversized.trustedKeys,
        isolatedRootDirectory: oversized.isolated,
        launcher: {
          launch: async (request) => {
            await writeFile(
              request.environment.SCR_SMOKE_REPORT_PATH!,
              Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
            );
            return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
          },
        },
      }),
      "REPORT_INVALID",
    );

    const linked = await createReadyCandidate();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: linked.slots,
        releaseId: linked.manifest.releaseId,
        trustedKeys: linked.trustedKeys,
        isolatedRootDirectory: linked.isolated,
        launcher: {
          launch: async (request) => {
            const reportPath = request.environment.SCR_SMOKE_REPORT_PATH!;
            await writeFile(reportPath, `${JSON.stringify(validReport(request))}\n`, "utf8");
            await link(reportPath, `${reportPath}.alias`);
            return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
          },
        },
      }),
      "REPORT_INVALID",
    );
  });

  it("retains isolated artifacts only when explicitly requested", async () => {
    const candidate = await createReadyCandidate();
    const result = await runCandidatePreflight({
      slotsDirectory: candidate.slots,
      releaseId: candidate.manifest.releaseId,
      trustedKeys: candidate.trustedKeys,
      isolatedRootDirectory: candidate.isolated,
      launcher: new ReportLauncher(),
      retainArtifacts: true,
    });

    expect(result.artifactsDirectory).toEqual(expect.any(String));
    await expect(access(result.artifactsDirectory!)).resolves.toBeUndefined();
    const report = await readFile(
      join(result.artifactsDirectory!, "candidate-smoke-report.json"),
      "utf8",
    );
    expect(JSON.parse(report)).toMatchObject({ ok: true });
  });

  it("rejects invalid paths, timeouts, and pre-cancelled signals", async () => {
    const candidate = await createReadyCandidate();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: candidate.slots,
        releaseId: candidate.manifest.releaseId,
        trustedKeys: candidate.trustedKeys,
        isolatedRootDirectory: "relative-path",
        launcher: new ReportLauncher(),
      }),
      "INVALID_INPUT",
    );
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: candidate.slots,
        releaseId: candidate.manifest.releaseId,
        trustedKeys: candidate.trustedKeys,
        isolatedRootDirectory: candidate.isolated,
        timeoutMs: 999,
        launcher: new ReportLauncher(),
      }),
      "INVALID_INPUT",
    );
    const abort = new AbortController();
    abort.abort();
    await expectPreflightCode(
      () => runCandidatePreflight({
        slotsDirectory: candidate.slots,
        releaseId: candidate.manifest.releaseId,
        trustedKeys: candidate.trustedKeys,
        isolatedRootDirectory: candidate.isolated,
        signal: abort.signal,
        launcher: new ReportLauncher(),
      }),
      "CANCELLED",
    );
  });
});