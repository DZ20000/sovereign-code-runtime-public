import { describe, expect, it } from "vitest";

import {
  SANDBOX_COLLECTION_SCHEMA_VERSION,
  SandboxArtifactCollector,
} from "../src/sandbox-artifact-collector.js";
import type {
  SandboxProcessResult,
  SandboxProcessRunner,
} from "../src/sandbox-process-runner.js";

interface GitCall {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv | undefined;
}

function result(
  stdout = "",
  stderr = "",
  exitCode = 0,
  overrides: Partial<SandboxProcessResult> = {},
): SandboxProcessResult {
  return {
    commandLabel: "git",
    exitCode,
    signal: null,
    durationMs: 1,
    stdout,
    stderr,
    outputTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function happyRunner(
  options: {
    readonly url?: string;
    readonly configNames?: string;
    readonly advertised?: readonly (readonly [string, string])[];
    readonly verifyAll?: boolean;
    readonly existingRefs?: readonly (readonly [string, string])[];
    readonly verifiedObjectType?: string;
  } = {},
): { readonly runner: SandboxProcessRunner; readonly calls: GitCall[] } {
  const calls: GitCall[] = [];
  const advertised = options.advertised ?? [
    ["main", "a".repeat(40)],
    ["feature/artifact", "b".repeat(40)],
  ];
  let fetched: readonly string[] = [];
  const runner: SandboxProcessRunner = async (command, args, runOptions) => {
    expect(command).toBe("git");
    calls.push({ args: [...args], environment: runOptions.environment });
    if (args[0] === "config" && args.includes("--name-only")) {
      return result(options.configNames ?? "core.repositoryformatversion\n");
    }
    if (args[0] === "config" && args.includes("--get-all")) {
      return result(options.url ?? "git://127.0.0.1:9418/sovereign/test.git\n");
    }
    if (args.includes("ls-remote")) {
      return result(
        advertised
          .map(([branch, commit]) => `${commit}\trefs/heads/${branch}`)
          .join("\n") + "\n",
      );
    }
    if (args.includes("fetch")) {
      fetched = args.filter((argument) => argument.startsWith("+refs/heads/"));
      return result();
    }
    if (args.includes("for-each-ref")) {
      const verifiesObjectType = args.some((argument) =>
        argument.includes("%(objecttype)"),
      );
      if (!verifiesObjectType) {
        const lines = (options.existingRefs ?? []).map(
          ([ref, commit]) => `${ref}\t${commit}`,
        );
        return result(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
      }
      const lines = fetched
        .slice(
          0,
          options.verifyAll === false
            ? Math.max(0, fetched.length - 1)
            : fetched.length,
        )
        .map((refspec) => {
          const [source, target] = refspec.slice(1).split(":");
          const branch = source!.slice("refs/heads/".length);
          const commit = advertised.find(
            ([candidate]) => candidate === branch,
          )![1];
          return `${target}\t${commit}\t${options.verifiedObjectType ?? "commit"}`;
        });
      return result(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    }
    if (args.includes("update-ref")) return result();
    return result("", `unexpected git args: ${args.join(" ")}`, 2);
  };
  return { runner, calls };
}

describe("SandboxArtifactCollector", () => {
  it("fetches only committed loopback Git branches into isolated Sovereign refs", async () => {
    const { runner, calls } = happyRunner();
    const collector = new SandboxArtifactCollector({
      workspaceRoot: "C:\\workspace",
      runner,
    });
    const sandboxId = "7b7decd0-d046-4d63-b6f1-8260ef6ca638";

    const collected = await collector.collect(
      sandboxId,
      "sovereign-build-1234abcd",
    );

    expect(collected).toMatchObject({
      schemaVersion: SANDBOX_COLLECTION_SCHEMA_VERSION,
      sandboxId,
      refCount: 2,
      refs: [
        { branch: "main", commit: "a".repeat(40) },
        { branch: "feature/artifact", commit: "b".repeat(40) },
      ],
    });
    expect(collected.collectionId).toMatch(/^[0-9a-f-]{36}$/u);
    for (const ref of collected.refs) {
      expect(ref.ref).toMatch(
        new RegExp(
          `^refs/sovereign/sandboxes/${sandboxId}/branches/[a-f0-9]{64}$`,
          "u",
        ),
      );
      expect(ref.ref).not.toContain(collected.collectionId);
    }

    const fetch = calls.find((call) => call.args.includes("fetch"));
    expect(fetch?.args).toEqual(
      expect.arrayContaining([
        "--atomic",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "git://127.0.0.1:9418/sovereign/test.git",
      ]),
    );
    expect(
      fetch?.args.some(
        (argument) => argument === "checkout" || argument === "merge",
      ),
    ).toBe(false);
    expect(fetch?.environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    });
  });

  it("rejects non-loopback or credential-bearing Git remotes before contacting them", async () => {
    for (const url of [
      "https://example.com/repo.git",
      "git://example.com/repo.git",
      "git://user@127.0.0.1:9418/repo.git",
      "file:///C:/repo.git",
    ]) {
      const { runner, calls } = happyRunner({ url });
      const collector = new SandboxArtifactCollector({
        workspaceRoot: "C:\\workspace",
        runner,
      });
      await expect(
        collector.collect(
          "7b7decd0-d046-4d63-b6f1-8260ef6ca638",
          "sovereign-build-1234abcd",
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls.some((call) => call.args.includes("ls-remote"))).toBe(false);
      expect(calls.some((call) => call.args.includes("fetch"))).toBe(false);
    }
  });

  it("rejects repository-local include and URL rewrite configuration", async () => {
    for (const configNames of [
      "include.path\n",
      "includeif.gitdir:c:/repo.path\n",
      "url.git://127.0.0.1:9418/.insteadof\n",
    ]) {
      const { runner, calls } = happyRunner({ configNames });
      const collector = new SandboxArtifactCollector({
        workspaceRoot: "C:\\workspace",
        runner,
      });
      await expect(
        collector.collect(
          "7b7decd0-d046-4d63-b6f1-8260ef6ca638",
          "sovereign-build-1234abcd",
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(calls.some((call) => call.args.includes("--get-all"))).toBe(false);
    }
  });

  it("CAS-removes stale stable refs after a successful fetch", async () => {
    const sandboxId = "7b7decd0-d046-4d63-b6f1-8260ef6ca638";
    const staleRef = `refs/sovereign/sandboxes/${sandboxId}/branches/${"e".repeat(64)}`;
    const staleCommit = "e".repeat(40);
    const { runner, calls } = happyRunner({
      existingRefs: [[staleRef, staleCommit]],
    });

    await expect(
      new SandboxArtifactCollector({
        workspaceRoot: "C:\\workspace",
        runner,
      }).collect(sandboxId, "sovereign-build-1234abcd"),
    ).resolves.toMatchObject({ refCount: 2 });

    expect(
      calls.some(
        (call) =>
          call.args.includes("update-ref") &&
          call.args.includes("-d") &&
          call.args.includes(staleRef) &&
          call.args.includes(staleCommit),
      ),
    ).toBe(true);
  });

  it("rejects collected refs that do not resolve directly to commits", async () => {
    const { runner } = happyRunner({ verifiedObjectType: "tag" });
    await expect(
      new SandboxArtifactCollector({
        workspaceRoot: "C:\\workspace",
        runner,
      }).collect(
        "7b7decd0-d046-4d63-b6f1-8260ef6ca638",
        "sovereign-build-1234abcd",
      ),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
  });

  it("bounds advertised branch cardinality and requires complete post-fetch verification", async () => {
    const advertised = Array.from(
      { length: 65 },
      (_value, index) =>
        [`branch-${index + 1}`, index.toString(16).padStart(40, "0")] as const,
    );
    const tooMany = happyRunner({ advertised });
    await expect(
      new SandboxArtifactCollector({
        workspaceRoot: "C:\\workspace",
        runner: tooMany.runner,
      }).collect(
        "7b7decd0-d046-4d63-b6f1-8260ef6ca638",
        "sovereign-build-1234abcd",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(tooMany.calls.some((call) => call.args.includes("fetch"))).toBe(
      false,
    );

    const incomplete = happyRunner({ verifyAll: false });
    await expect(
      new SandboxArtifactCollector({
        workspaceRoot: "C:\\workspace",
        runner: incomplete.runner,
      }).collect(
        "7b7decd0-d046-4d63-b6f1-8260ef6ca638",
        "sovereign-build-1234abcd",
      ),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
  });
});
