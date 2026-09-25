import { createHash, randomUUID } from "node:crypto";

import { RuntimeError } from "@sovereign/runtime-core";

import {
  defaultSandboxProcessRunner,
  sandboxHostEnvironment,
  type SandboxProcessResult,
  type SandboxProcessRunner,
} from "./sandbox-process-runner.js";

export const SANDBOX_COLLECTION_SCHEMA_VERSION =
  "scr.sandbox-collection/v1" as const;

const MAX_COLLECTION_BRANCHES = 64;
const MAX_GIT_OUTPUT_BYTES = 262_144;
const MAX_REMOTE_URL_CHARACTERS = 2_048;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;
const SAFE_BRANCH = /^[^\0-\x20~^:?*\\\[][^\0-\x20~^:?*\\\[]*$/u;

export interface SandboxCollectedRef {
  readonly branch: string;
  readonly commit: string;
  readonly ref: string;
}

export interface SandboxCollectionResult {
  readonly schemaVersion: typeof SANDBOX_COLLECTION_SCHEMA_VERSION;
  readonly sandboxId: string;
  readonly collectionId: string;
  readonly refCount: number;
  readonly refs: readonly SandboxCollectedRef[];
}

export interface SandboxArtifactCollectorOptions {
  readonly workspaceRoot: string;
  readonly runner?: SandboxProcessRunner;
}

interface RemoteHead {
  readonly branch: string;
  readonly commit: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return sandboxHostEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
  });
}

function safeGitConfig(): readonly string[] {
  return [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.git.allow=always",
    "-c",
    "credential.helper=",
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.gitProxy=",
    "-c",
    "fetch.writeCommitGraph=false",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
  ];
}

function assertLoopbackGitUrl(value: string): string {
  if (value.length === 0 || value.length > MAX_REMOTE_URL_CHARACTERS) {
    throw new RuntimeError(
      "POLICY_DENIED",
      "Sandbox Git remote URL is outside the reviewed bound.",
      403,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeError(
      "POLICY_DENIED",
      "Sandbox Git remote URL is malformed.",
      403,
    );
  }
  const host = parsed.hostname
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase("en-US");
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "git:" ||
    !["127.0.0.1", "localhost", "::1"].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new RuntimeError(
      "POLICY_DENIED",
      "Sandbox Git collection accepts only the provider-managed loopback git-daemon remote.",
      403,
    );
  }
  return parsed.toString();
}

function parseRemoteHeads(output: string): readonly RemoteHead[] {
  const heads = new Map<string, string>();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const [commit, ref, ...extra] = line.split("\t");
    if (
      extra.length > 0 ||
      commit === undefined ||
      ref === undefined ||
      !GIT_OBJECT_ID.test(commit) ||
      !ref.startsWith("refs/heads/")
    ) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Sandbox Git daemon returned malformed branch metadata.",
        502,
      );
    }
    const branch = ref.slice("refs/heads/".length);
    if (
      branch.length === 0 ||
      branch.length > 240 ||
      !SAFE_BRANCH.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.startsWith(".") ||
      branch.endsWith(".") ||
      branch.endsWith("/") ||
      branch.includes("//") ||
      branch
        .split("/")
        .some((part) => part.startsWith(".") || part.endsWith(".lock"))
    ) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Sandbox Git daemon returned an unsafe branch name.",
        502,
      );
    }
    if (heads.has(branch)) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Sandbox Git daemon returned duplicate branch metadata.",
        502,
      );
    }
    heads.set(branch, commit);
    if (heads.size > MAX_COLLECTION_BRANCHES) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Sandbox collection is limited to ${MAX_COLLECTION_BRANCHES} branch refs per operation.`,
        409,
      );
    }
  }
  if (heads.size === 0) {
    throw new RuntimeError(
      "POLICY_DENIED",
      "Sandbox has no committed branch refs to collect. Commit the work on a branch first.",
      409,
    );
  }
  return [...heads].map(([branch, commit]) => ({ branch, commit }));
}

interface LocalRef {
  readonly ref: string;
  readonly commit: string;
  readonly objectType?: string;
}

function branchRef(prefix: string, branch: string): string {
  const digest = createHash("sha256").update(branch, "utf8").digest("hex");
  return `${prefix}/${digest}`;
}

function parseLocalRefs(
  output: string,
  prefix: string,
  requireCommitType: boolean,
): readonly LocalRef[] {
  const refs = new Map<string, LocalRef>();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const fields = line.split("\t");
    if (
      fields.length !== (requireCommitType ? 3 : 2) ||
      fields[0] === undefined ||
      fields[1] === undefined ||
      !fields[0].startsWith(`${prefix}/`) ||
      !GIT_OBJECT_ID.test(fields[1]) ||
      (requireCommitType && fields[2] !== "commit")
    ) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Collected sandbox refs failed verification.",
        502,
      );
    }
    if (refs.has(fields[0])) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Collected sandbox refs contain duplicates.",
        502,
      );
    }
    refs.set(fields[0], {
      ref: fields[0],
      commit: fields[1],
      ...(requireCommitType ? { objectType: fields[2] } : {}),
    });
    if (refs.size > MAX_COLLECTION_BRANCHES) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Sandbox collection state exceeds the ${MAX_COLLECTION_BRANCHES}-ref bound.`,
        409,
      );
    }
  }
  return [...refs.values()];
}

export class SandboxArtifactCollector {
  readonly #workspaceRoot: string;
  readonly #runner: SandboxProcessRunner;

  constructor(options: SandboxArtifactCollectorOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#runner = options.runner ?? defaultSandboxProcessRunner;
  }

  async collect(
    sandboxId: string,
    sandboxName: string,
  ): Promise<SandboxCollectionResult> {
    const remoteName = `sandbox-${sandboxName}`;
    const config = await this.#git(
      ["config", "--local", "--no-includes", "--name-only", "--list"],
      15_000,
    );
    this.#assertGitSuccess(config, "inspect repository Git configuration");
    const unsafeConfig = config.stdout
      .split(/\r?\n/u)
      .map((key) => key.trim().toLocaleLowerCase("en-US"))
      .filter(Boolean)
      .find(
        (key) =>
          key.startsWith("include.") ||
          key.startsWith("includeif.") ||
          (key.startsWith("url.") && key.endsWith(".insteadof")),
      );
    if (unsafeConfig !== undefined) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Sandbox collection refuses repository-local Git include or URL rewrite rules.",
        403,
      );
    }

    const urlResult = await this.#git(
      [
        "config",
        "--local",
        "--no-includes",
        "--get-all",
        `remote.${remoteName}.url`,
      ],
      15_000,
    );
    if (
      urlResult.exitCode === 1 &&
      !urlResult.timedOut &&
      !urlResult.outputTruncated
    ) {
      throw new RuntimeError(
        "PATH_NOT_FOUND",
        "Managed sandbox Git remote was not found.",
        404,
      );
    }
    this.#assertGitSuccess(urlResult, "read the managed sandbox Git remote");
    const urls = urlResult.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (urls.length !== 1) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Managed sandbox Git remote must have exactly one URL.",
        403,
      );
    }
    const remoteUrl = assertLoopbackGitUrl(urls[0]!);

    const advertised = await this.#git(
      [...safeGitConfig(), "ls-remote", "--heads", "--refs", remoteUrl],
      30_000,
    );
    this.#assertGitSuccess(advertised, "inspect committed sandbox branches");
    const heads = parseRemoteHeads(advertised.stdout);
    const collectionId = randomUUID();
    const prefix = `refs/sovereign/sandboxes/${sandboxId}/branches`;
    const expectedRefs = new Map(
      heads.map(({ branch }) => [branchRef(prefix, branch), branch] as const),
    );
    const existingResult = await this.#git(
      [
        ...safeGitConfig(),
        "for-each-ref",
        "--format=%(refname)%09%(objectname)",
        prefix,
      ],
      15_000,
    );
    this.#assertGitSuccess(
      existingResult,
      "inspect previous sandbox collection refs",
    );
    const existingRefs = parseLocalRefs(existingResult.stdout, prefix, false);
    const refspecs = heads.map(
      ({ branch }) => `+refs/heads/${branch}:${branchRef(prefix, branch)}`,
    );
    const fetched = await this.#git(
      [
        ...safeGitConfig(),
        "fetch",
        "--atomic",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        remoteUrl,
        ...refspecs,
      ],
      120_000,
    );
    this.#assertGitSuccess(fetched, "collect committed sandbox branches");

    for (const stale of existingRefs.filter(
      (entry) => !expectedRefs.has(entry.ref),
    )) {
      const removed = await this.#git(
        [...safeGitConfig(), "update-ref", "-d", stale.ref, stale.commit],
        15_000,
      );
      this.#assertGitSuccess(removed, "remove a stale sandbox collection ref");
    }

    const listed = await this.#git(
      [
        ...safeGitConfig(),
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(objecttype)",
        prefix,
      ],
      15_000,
    );
    this.#assertGitSuccess(listed, "verify collected sandbox refs");
    const verifiedRefs = parseLocalRefs(listed.stdout, prefix, true);
    const refsByName = new Map(
      verifiedRefs.map((entry) => [entry.ref, entry.commit]),
    );
    const refs = heads.map(({ branch }) => {
      const ref = branchRef(prefix, branch);
      const commit = refsByName.get(ref);
      if (commit === undefined) {
        throw new RuntimeError(
          "PROCESS_FAILED",
          "Collected sandbox refs are incomplete.",
          502,
        );
      }
      return { branch, commit, ref } satisfies SandboxCollectedRef;
    });
    if (refsByName.size !== refs.length) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Collected sandbox refs contain unexpected entries.",
        502,
      );
    }
    return {
      schemaVersion: SANDBOX_COLLECTION_SCHEMA_VERSION,
      sandboxId,
      collectionId,
      refCount: refs.length,
      refs,
    };
  }

  async #git(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<SandboxProcessResult> {
    if (
      args.length === 0 ||
      args.length > 256 ||
      args.some(
        (argument) => argument.length > 4_096 || argument.includes("\0"),
      )
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Sandbox Git arguments are outside the reviewed bound.",
        400,
      );
    }
    return await this.#runner("git", args, {
      cwd: this.#workspaceRoot,
      timeoutMs,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      environment: gitEnvironment(),
    });
  }

  #assertGitSuccess(result: SandboxProcessResult, operation: string): void {
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
      throw new RuntimeError(
        result.timedOut ? "PROCESS_TIMEOUT" : "PROCESS_FAILED",
        `Could not ${operation}.`,
        result.timedOut ? 504 : 502,
      );
    }
  }
}
