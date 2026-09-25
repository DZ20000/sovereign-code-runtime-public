import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import { ToolCatalog } from "@sovereign/toolkit";

import { CredentialReferenceStore } from "../src/credential-references.js";
import {
  SBX_REVIEWED_VERSION,
  SandboxManager,
  type SandboxProcessRunner,
} from "../src/sandbox-manager.js";
import { createSecureExecutionToolPack } from "../src/secure-execution-tools.js";

const cleanupPaths: string[] = [];

async function createPack(): Promise<{
  readonly pack: ReturnType<typeof createSecureExecutionToolPack>;
  readonly catalog: ToolCatalog;
  readonly audit: MemoryAuditStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-secure-tools-"));
  cleanupPaths.push(root);
  const workspaceRoot = join(root, "workspace");
  const userDataRoot = join(root, "user-data");
  const executableRoot = join(root, "bin");
  await Promise.all([
    mkdir(join(workspaceRoot, ".git"), { recursive: true }),
    mkdir(userDataRoot, { recursive: true }),
    mkdir(executableRoot, { recursive: true }),
  ]);
  const executablePath = join(executableRoot, "sbx.exe");
  const executableBytes = Buffer.from("secure tool fake sbx", "utf8");
  await writeFile(executablePath, executableBytes);
  const executableSha256 = createHash("sha256")
    .update(executableBytes)
    .digest("hex");
  const runner: SandboxProcessRunner = async (_command, args) => {
    if (args[0] === "version") {
      return {
        commandLabel: "sbx version",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: `sbx version: v${SBX_REVIEWED_VERSION} deadbeef\n`,
        stderr: "",
        outputTruncated: false,
        timedOut: false,
      };
    }
    return {
      commandLabel: "sbx ls",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "[]",
      stderr: "",
      outputTruncated: false,
      timedOut: false,
    };
  };
  const credentialReferences = new CredentialReferenceStore(
    join(userDataRoot, "credential-refs.json"),
    {
      storageRoot: userDataRoot,
      protectReference: async (value) =>
        `test-protected:${Buffer.from(value, "utf8").toString("base64url")}`,
      restoreReference: async (encoded) =>
        encoded.startsWith("test-protected:")
          ? {
              value: Buffer.from(
                encoded.slice("test-protected:".length),
                "base64url",
              ).toString("utf8"),
              encoded,
            }
          : null,
    },
  );
  const collectedCommit = "d".repeat(40);
  let collectedDestinationRef = "";
  const gitRunner: SandboxProcessRunner = async (_command, args) => {
    if (args[0] === "config" && args.includes("--name-only")) {
      return {
        commandLabel: "git config",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "core.repositoryformatversion\n",
        stderr: "",
        outputTruncated: false,
        timedOut: false,
      };
    }
    if (args[0] === "config" && args.includes("--get-all")) {
      return {
        commandLabel: "git config",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "git://127.0.0.1:9418/secure-tool-test.git\n",
        stderr: "",
        outputTruncated: false,
        timedOut: false,
      };
    }
    if (args.includes("ls-remote")) {
      return {
        commandLabel: "git ls-remote",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: `${collectedCommit}\trefs/heads/feature/private-output\n`,
        stderr: "",
        outputTruncated: false,
        timedOut: false,
      };
    }
    if (args.includes("fetch")) {
      const refspec = args.find((argument) =>
        argument.startsWith("+refs/heads/feature/private-output:"),
      );
      collectedDestinationRef = refspec?.split(":", 2)[1] ?? "";
      return {
        commandLabel: "git fetch",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        timedOut: false,
      };
    }
    if (args.includes("for-each-ref")) {
      const verifiesObjectType = args.some((argument) =>
        argument.includes("%(objecttype)"),
      );
      return {
        commandLabel: "git for-each-ref",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: verifiesObjectType
          ? `${collectedDestinationRef}\t${collectedCommit}\tcommit\n`
          : "",
        stderr: "",
        outputTruncated: false,
        timedOut: false,
      };
    }
    throw new Error(`Unexpected Git call: ${args.join(" ")}`);
  };
  const sandboxes = new SandboxManager({
    workspaceRoot,
    registryPath: join(userDataRoot, "sandboxes.json"),
    executablePath,
    expectedVersion: SBX_REVIEWED_VERSION,
    expectedExecutableSha256: executableSha256,
    runner,
    gitRunner,
  });
  const audit = new MemoryAuditStore();
  const pack = createSecureExecutionToolPack({
    credentialReferences,
    sandboxes,
    audit,
    workspaceId: "workspace",
  });
  return {
    pack,
    catalog: new ToolCatalog(pack.definitions, new PolicyEngine(), "test"),
    audit,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});

describe("secure execution tool pack", () => {
  it("is opt-in and exposes only reviewed reference and sandbox operations", async () => {
    const { pack } = await createPack();

    expect(pack).toMatchObject({
      id: "secure-execution",
      version: "1.1.0",
      enabledByDefault: false,
    });
    expect(pack.definitions.map((definition) => definition.spec.name)).toEqual([
      "secrets.refs.list",
      "secrets.refs.register",
      "secrets.refs.remove",
      "sandbox.capabilities",
      "sandbox.list",
      "sandbox.create",
      "sandbox.exec",
      "sandbox.collect",
      "sandbox.stop",
      "sandbox.remove",
    ]);
    const byName = new Map(
      pack.definitions.map((definition) => [
        definition.spec.name,
        definition.spec,
      ]),
    );
    expect(byName.get("secrets.refs.list")).toMatchObject({
      category: "secrets",
      permissionLevel: "observe",
      requiredCapabilities: ["secrets.read"],
    });
    expect(byName.get("sandbox.create")).toMatchObject({
      category: "sandbox",
      permissionLevel: "workspace",
      requiredCapabilities: ["sandbox.run"],
      destructive: false,
    });
    expect(byName.get("sandbox.collect")).toMatchObject({
      permissionLevel: "workspace",
      approvalMode: "session",
      sideEffect: "write",
      destructive: false,
      requiredCapabilities: ["sandbox.manage"],
    });
    expect(byName.get("sandbox.remove")).toMatchObject({
      permissionLevel: "consequential",
      approvalMode: "single-use",
      destructive: true,
      requiredCapabilities: ["sandbox.manage"],
    });
    const registerSchema = JSON.stringify(
      byName.get("secrets.refs.register")?.inputSchema,
    );
    expect(registerSchema).not.toMatch(/"token"|"secret"|"value"/u);
  });

  it("registers opaque sources without returning reference values or sensitive audit data", async () => {
    const { catalog, audit } = await createPack();
    const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    const registered = await catalog.invoke(
      "secrets.refs.register",
      { principal },
      {
        id: "openai-build",
        label: "OpenAI build key",
        service: "openai",
        source: {
          kind: "onepassword",
          reference: "op://Engineering/OpenAI-API-Key/credential",
        },
      },
    );
    expect(registered).toMatchObject({
      id: "openai-build",
      service: "openai",
      sourceKind: "onepassword",
      sourceDisplay: "1Password reference",
      receiptId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    expect(JSON.stringify(registered)).not.toContain("op://");

    await expect(
      catalog.invoke("secrets.refs.list", { principal }, {}),
    ).resolves.toMatchObject({
      count: 1,
      entries: [expect.objectContaining({ id: "openai-build" })],
    });
    await expect(
      catalog.invoke(
        "secrets.refs.register",
        { principal },
        {
          id: "openai-via-gh",
          label: "Invalid source",
          service: "openai",
          source: { kind: "github-cli" },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const receipts = audit.list(10);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: "owner",
          toolName: "secrets.refs.register",
          operation: "register_credential_reference",
          outcome: "succeeded",
          workspaceId: "workspace",
          details: expect.objectContaining({
            credentialId: "openai-build",
            service: "openai",
            sourceKind: "onepassword",
            labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        }),
        expect.objectContaining({
          toolName: "secrets.refs.register",
          outcome: "failed",
          errorCode: "INVALID_INPUT",
          details: expect.objectContaining({
            credentialId: "openai-via-gh",
            sourceKind: "github-cli",
          }),
        }),
      ]),
    );
    const auditJson = JSON.stringify(receipts);
    expect(auditJson).not.toContain("op://");
    expect(auditJson).not.toContain("OpenAI-API-Key");
    expect(auditJson).not.toContain("OpenAI build key");
  });

  it("audits sandbox mutations without command text or output", async () => {
    const { catalog, audit } = await createPack();
    const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    const created = (await catalog.invoke(
      "sandbox.create",
      { principal },
      {
        workspaceId: "workspace",
        label: "Audit sandbox",
        cpus: 2,
        memoryMiB: 4_096,
      },
    )) as { readonly id: string; readonly receiptId: string };
    expect(created.receiptId).toMatch(/^[a-f0-9-]{36}$/u);

    const executed = (await catalog.invoke(
      "sandbox.exec",
      { principal },
      {
        workspaceId: "workspace",
        sandboxId: created.id,
        command: "printf 'sensitive-command-marker'",
        timeoutMs: 30_000,
      },
    )) as { readonly receiptId: string };
    expect(executed.receiptId).toMatch(/^[a-f0-9-]{36}$/u);

    const collected = (await catalog.invoke(
      "sandbox.collect",
      { principal },
      { workspaceId: "workspace", sandboxId: created.id },
    )) as {
      readonly collectionId: string;
      readonly refCount: number;
      readonly refs: ReadonlyArray<{
        readonly branch: string;
        readonly commit: string;
        readonly ref: string;
      }>;
      readonly receiptId: string;
    };
    expect(collected).toMatchObject({
      refCount: 1,
      refs: [
        expect.objectContaining({
          branch: "feature/private-output",
          commit: "d".repeat(40),
          ref: expect.stringContaining(
            `refs/sovereign/sandboxes/${created.id}/`,
          ),
        }),
      ],
      receiptId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });

    const receipts = audit.list(20);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "sandbox.create",
          operation: "create_sandbox",
          outcome: "succeeded",
          details: expect.objectContaining({
            isolationMode: "clone",
            network: "deny-all",
            cpus: 2,
            memoryMiB: 4_096,
          }),
        }),
        expect.objectContaining({
          toolName: "sandbox.exec",
          operation: "execute_sandbox_command",
          outcome: "succeeded",
          details: expect.objectContaining({
            sandboxId: created.id,
            commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            commandBytes: expect.any(Number),
            stdoutBytes: expect.any(Number),
            stderrBytes: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          toolName: "sandbox.collect",
          operation: "collect_sandbox_commits",
          outcome: "succeeded",
          details: expect.objectContaining({
            sandboxId: created.id,
            collectionId: collected.collectionId,
            refCount: 1,
          }),
        }),
      ]),
    );
    const auditJson = JSON.stringify(receipts);
    expect(auditJson).not.toContain("sensitive-command-marker");
    expect(auditJson).not.toContain("printf");
    expect(auditJson).not.toContain("sandbox-output");
    expect(auditJson).not.toContain("feature/private-output");
    expect(auditJson).not.toContain("git://127.0.0.1:9418");
  });

  it("returns bounded trusted sandbox capabilities without creating a sandbox", async () => {
    const { catalog } = await createPack();
    const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    await expect(
      catalog.invoke(
        "sandbox.capabilities",
        { principal },
        { workspaceId: "workspace" },
      ),
    ).resolves.toMatchObject({
      provider: "docker-sbx",
      available: true,
      trusted: true,
      compatible: true,
      authenticated: true,
      expectedVersion: SBX_REVIEWED_VERSION,
      guarantees: {
        microVm: true,
        privateClone: true,
        hostRepositoryReadOnly: true,
        network: "deny-all",
        hostShell: false,
        privilegedExec: false,
        hostPathCopy: false,
      },
    });
  });
});
