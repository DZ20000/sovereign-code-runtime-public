import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  RuntimeError,
  createPrincipal,
} from "@sovereign/runtime-core";
import {
  ToolCatalog,
  defineTool,
  objectSchema,
  type RuntimeToolDefinition,
} from "@sovereign/toolkit";

import {
  CapabilityDirectory,
  createCapabilityDirectoryTools,
} from "../src/capability-directory.js";
import type { ToolPackStatus } from "../src/tool-pack-manager.js";

function target(options: {
  readonly name: string;
  readonly category: "system" | "git" | "terminal" | "tasks";
  readonly permissionLevel: "observe" | "workspace" | "consequential";
  readonly destructive?: boolean;
}): RuntimeToolDefinition {
  const approvalMode =
    options.permissionLevel === "observe"
      ? "none"
      : options.permissionLevel === "workspace"
        ? "session"
        : "single-use";
  return defineTool(
    {
      name: options.name,
      version: "1.0.0",
      title: options.name,
      description: `Capability ${options.name}.`,
      category: options.category,
      requiredCapabilities: ["system.read"],
      sideEffect: options.permissionLevel === "observe" ? "read" : "process",
      destructive: options.destructive ?? false,
      permissionLevel: options.permissionLevel,
      approvalMode,
      inputSchema: objectSchema(
        { value: { type: "string", maxLength: 500 } },
        [],
      ),
    },
    { value: z.string().max(500).optional() },
    (_context, input) => ({ target: options.name, input }),
  );
}

function packStatus(): ToolPackStatus {
  return {
    schemaVersion: "scr.tool-packs/status/v1",
    configFile: "tool-packs.json",
    generation: 3,
    enabled: ["developer-essentials"],
    available: [
      {
        id: "developer-essentials",
        version: "1.2.0",
        title: "Developer essentials",
        description: "Test pack.",
        enabled: true,
        toolNames: ["git.inspect"],
      },
      {
        id: "semantic-code",
        version: "1.0.0",
        title: "Semantic code",
        description: "Disabled test pack.",
        enabled: false,
        toolNames: ["code.symbol.find"],
      },
    ],
    manifestDigest: "0".repeat(64),
    toolCount: 0,
    lastReloadAt: "2026-08-23T00:00:00.000Z",
    lastError: null,
  };
}

function fixture(): {
  readonly audit: MemoryAuditStore;
  readonly catalog: ToolCatalog;
  readonly directory: CapabilityDirectory;
  readonly principal: ReturnType<typeof createPrincipal>;
  readonly invokeSpy: ReturnType<typeof vi.fn>;
} {
  const audit = new MemoryAuditStore();
  const directory = new CapabilityDirectory({ audit });
  const invokeSpy = vi.fn(
    async (_context: unknown, toolName: string, input: unknown) => ({
      toolName,
      input,
    }),
  );
  const definitions = [
    ...createCapabilityDirectoryTools(directory),
    target({
      name: "git.inspect",
      category: "git",
      permissionLevel: "observe",
    }),
    target({
      name: "system.healthcheck",
      category: "system",
      permissionLevel: "observe",
    }),
    target({
      name: "terminal.start",
      category: "terminal",
      permissionLevel: "consequential",
    }),
    target({
      name: "tasks.inbox",
      category: "tasks",
      permissionLevel: "observe",
    }),
  ];
  const catalog = new ToolCatalog(
    definitions,
    new PolicyEngine(),
    "test-runtime",
  );
  directory.bind({
    definitions: () => catalog.definitions,
    manifest: () => catalog.manifest,
    toolPacks: packStatus,
    describeAuthorization: () => null,
    invoke: invokeSpy,
  });
  return {
    audit,
    catalog,
    directory,
    principal: createPrincipal("owner", CAPABILITIES, ["workspace"]),
    invokeSpy,
  };
}

describe("stable capability directory", () => {
  it("searches, paginates, and describes active tools with pack ownership", () => {
    const { catalog, directory } = fixture();
    const search = directory.search({ query: "git", limit: 10 });
    expect(search.schemaVersion).toBe("scr.capabilities/search/v1");
    expect(search.query).toBe("git");
    expect(search.totalMatched).toBe(1);
    expect(search.returned).toBe(1);
    expect(search.nextCursor).toBeNull();
    expect(search.entries).toHaveLength(1);
    expect(search.entries[0]).toMatchObject({
      name: "git.inspect",
      facadeExecutable: true,
      pack: { id: "developer-essentials", version: "1.2.0" },
    });

    const firstPage = directory.search({ executableOnly: true, limit: 1 });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = directory.search({
      executableOnly: true,
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.entries[0]?.name).not.toBe(firstPage.entries[0]?.name);

    const staleCursor = firstPage.nextCursor;
    catalog.replaceDefinitions([
      ...catalog.definitions,
      target({
        name: "git.new-inspection",
        category: "git",
        permissionLevel: "observe",
      }),
    ]);
    expect(() =>
      directory.search({
        executableOnly: true,
        limit: 1,
        cursor: staleCursor ?? undefined,
      }),
    ).toThrow(/stale/u);

    expect(directory.describe("terminal.start")).toMatchObject({
      schemaVersion: "scr.capabilities/description/v1",
      name: "terminal.start",
      permissionLevel: "consequential",
      facadeExecutable: false,
      inputSchema: expect.any(Object),
    });
    expect(() => directory.describe("code.symbol.find")).toThrow(
      /Unknown active capability/u,
    );
  });

  it("executes only reviewed L1 categories and hashes input in audit", async () => {
    const { audit, directory, invokeSpy, principal } = fixture();
    const secretLikeValue = "do-not-store-this-plaintext";
    await expect(
      directory.execute({ principal }, "git.inspect", {
        value: secretLikeValue,
      }),
    ).resolves.toEqual({
      schemaVersion: "scr.capabilities/execution/v1",
      targetToolName: "git.inspect",
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      result: {
        toolName: "git.inspect",
        input: { value: secretLikeValue },
      },
    });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const receipt = audit.list(1)[0];
    expect(receipt).toMatchObject({
      principalId: "owner",
      toolName: "capabilities.execute",
      operation: "capability_dispatch",
      outcome: "succeeded",
      details: {
        targetToolName: "git.inspect",
        inputBytes: expect.any(Number),
        inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(secretLikeValue);
  });

  it("hashes target error text instead of retaining it in dispatch audit", async () => {
    const { audit, directory, invokeSpy, principal } = fixture();
    const sensitiveError = "sensitive-target-error-value";
    invokeSpy.mockRejectedValueOnce(
      new RuntimeError("INVALID_INPUT", sensitiveError, 400),
    );
    await expect(
      directory.execute({ principal }, "git.inspect", { value: "safe" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const receipt = audit.list(1)[0];
    expect(receipt).toMatchObject({
      outcome: "failed",
      errorCode: "INVALID_INPUT",
      details: {
        targetToolName: "git.inspect",
        errorMessageBytes: sensitiveError.length,
        errorMessageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(sensitiveError);
  });

  it("refuses and audits mutation, task, terminal, and recursive facade targets", async () => {
    const { audit, directory, invokeSpy, principal } = fixture();
    for (const toolName of [
      "terminal.start",
      "tasks.inbox",
      "capabilities.execute",
      "client.catalog_status",
    ]) {
      await expect(
        directory.execute({ principal }, toolName, {}),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    }
    expect(invokeSpy).not.toHaveBeenCalled();
    const receipts = audit.list(10);
    expect(receipts).toHaveLength(4);
    expect(receipts.every((receipt) => receipt.outcome === "denied")).toBe(
      true,
    );
    expect(
      receipts.every((receipt) => receipt.errorCode === "POLICY_DENIED"),
    ).toBe(true);
    expect(
      receipts.every(
        (receipt) =>
          receipt.toolName === "capabilities.execute" &&
          receipt.operation === "capability_dispatch",
      ),
    ).toBe(true);
  });

  it("compares explicit client snapshots without claiming cache introspection", () => {
    const { catalog, directory } = fixture();
    expect(directory.catalogStatus({})).toMatchObject({
      comparable: false,
      inSync: null,
      recommendedAction: "provide-client-snapshot",
    });
    expect(
      directory.catalogStatus({
        clientManifestDigest: catalog.manifest.digest,
        clientToolCount: catalog.manifest.tools.length,
        clientPackGeneration: 3,
      }),
    ).toMatchObject({
      comparable: true,
      inSync: true,
      mismatches: [],
      recommendedAction: "none",
    });
    expect(
      directory.catalogStatus({
        clientManifestDigest: "f".repeat(64),
        clientToolCount: 1,
        clientPackGeneration: 2,
      }),
    ).toMatchObject({
      inSync: false,
      mismatches: ["manifestDigest", "toolCount", "packGeneration"],
      recommendedAction: "refresh-actions-or-relist",
    });
  });
});
