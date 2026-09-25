import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import { WindowsAdapter } from "@sovereign/windows-adapter";
import {
  ToolCatalog,
  createBuiltinTools,
  createDeveloperEssentialsToolPack,
  type ToolExecutionActivityEvent,
  type ToolRejectionRequest,
} from "../src/index.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createCatalog(
  onRejected?: (request: ToolRejectionRequest) => void,
  onExecutionActivity?: (event: ToolExecutionActivityEvent) => void,
): Promise<ToolCatalog> {
  const root = await mkdtemp(join(tmpdir(), "scr-toolkit-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "safe"), { recursive: true });
  const policy = new PolicyEngine();
  const adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy,
    audit: new MemoryAuditStore(),
  });
  return new ToolCatalog(
    [
      ...createBuiltinTools(adapter),
      ...createDeveloperEssentialsToolPack(adapter).definitions,
    ],
    policy,
    "0.1.0",
    undefined,
    onRejected,
    onExecutionActivity,
  );
}

describe("tool catalog", () => {
  it("publishes a sorted, versioned manifest across the initial tool groups", async () => {
    const catalog = await createCatalog();
    const names = catalog.manifest.tools.map((tool) => tool.name);

    expect(catalog.manifest.schemaVersion).toBe("scr.tools/v1");
    expect(names).toEqual([...names].sort());
    expect(new Set(catalog.manifest.tools.map((tool) => tool.category))).toEqual(
      new Set([
        "system",
        "workspace",
        "files",
        "search",
        "git",
        "python",
        "runs",
        "validation",
        "terminal",
        "browser",
        "workflow",
        "computer",
      ]),
    );
  });

  it("publishes the bounded system notification contract", async () => {
    const catalog = await createCatalog();
    const notification = catalog.manifest.tools.find((tool) => tool.name === "system.notify");

    expect(notification).toMatchObject({
      category: "system",
      requiredCapabilities: ["system.notify"],
      sideEffect: "process",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    });
    expect(notification?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["title", "message"],
      properties: {
        title: { maxLength: 64 },
        message: { maxLength: 512 },
        durationMs: { minimum: 3_000, maximum: 15_000 },
      },
    });
  });

  it("publishes and invokes the expanded developer essentials pack", async () => {
    const catalog = await createCatalog();
    const names = catalog.manifest.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "files.read_lines",
      "git.show",
      "git.blame",
      "git.branches",
      "git.tags",
      "git.worktrees",
      "git.files",
      "system.capabilities",
      "runs.follow",
      "workspace.context",
      "workspace.snapshot",
      "git.summary",
      "validation.verify",
      "validation.release_check",
    ]));

    const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);
    await catalog.invoke(
      "files.create",
      { principal: owner },
      {
        workspaceId: "workspace",
        path: "safe\\numbered.txt",
        content: "one\ntwo\nthree\nfour\n",
      },
    );
    await expect(catalog.invoke(
      "files.read_lines",
      { principal: owner },
      {
        workspaceId: "workspace",
        path: "safe\\numbered.txt",
        startLine: 2,
        lineCount: 2,
      },
    )).resolves.toMatchObject({
      totalLines: 4,
      startLine: 2,
      endLine: 3,
      hasMore: true,
      lines: [
        { line: 2, text: "two" },
        { line: 3, text: "three" },
      ],
    });

    await expect(catalog.invoke(
      "git.show",
      { principal: owner },
      { workspaceId: "workspace", revision: "--help" },
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reports a policy rejection before invoking a missing capability", async () => {
    const rejections: ToolRejectionRequest[] = [];
    const catalog = await createCatalog((request) => rejections.push(request));
    const reader = createPrincipal(
      "reader",
      CAPABILITIES.filter((capability) => capability !== "files.write"),
      ["workspace"],
    );

    await expect(
      catalog.invoke(
        "files.create",
        { principal: reader },
        {
          workspaceId: "workspace",
          path: "safe\\blocked.txt",
          content: "blocked",
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      toolName: "files.create",
      stage: "policy",
      error: { code: "POLICY_DENIED" },
    });
  });

  it("reports schema rejection without echoing raw invalid input", async () => {
    const rejections: ToolRejectionRequest[] = [];
    const catalog = await createCatalog((request) => rejections.push(request));
    const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    await expect(
      catalog.invoke(
        "files.create",
        { principal: owner },
        {
          workspaceId: "workspace",
          path: "safe\\bad.txt",
          content: "ok",
          unexpectedSecret: "must-not-be-copied",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      toolName: "files.create",
      stage: "schema",
      error: { code: "INVALID_INPUT" },
    });
    expect(rejections[0]?.input).toBeUndefined();
  });

  it("reports bounded execution lifecycle events without input data", async () => {
    const events: ToolExecutionActivityEvent[] = [];
    const catalog = await createCatalog(undefined, (event) => events.push(event));
    const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    await expect(catalog.invoke("system.info", { principal: owner }, {})).resolves.toMatchObject({
      platform: "win32",
      processId: expect.any(Number),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      phase: "started",
      principalId: "owner",
      toolName: "system.info",
      title: "System information",
      category: "system",
      workspaceId: null,
      completedAt: null,
      durationMs: null,
      outcome: null,
      errorCode: null,
    });
    expect(events[1]).toMatchObject({
      id: events[0]?.id,
      phase: "completed",
      principalId: "owner",
      toolName: "system.info",
      workspaceId: null,
      completedAt: expect.any(String),
      durationMs: expect.any(Number),
      outcome: "succeeded",
      errorCode: null,
    });
    expect(JSON.stringify(events)).not.toContain("input");
  });

  it("completes execution activity as failed without replacing the tool error", async () => {
    const events: ToolExecutionActivityEvent[] = [];
    const catalog = await createCatalog(undefined, (event) => events.push(event));
    const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    await expect(catalog.invoke(
      "files.read",
      { principal: owner },
      { workspaceId: "workspace", path: "safe\\missing.txt" },
    )).rejects.toMatchObject({ code: expect.any(String) });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: "started", toolName: "files.read" });
    expect(events[1]).toMatchObject({
      id: events[0]?.id,
      phase: "completed",
      toolName: "files.read",
      outcome: "failed",
      errorCode: expect.any(String),
    });
  });
  it("atomically replaces definitions and notifies subscribers only for manifest changes", async () => {
    const catalog = await createCatalog();
    const originalManifest = catalog.manifest;
    const changes: string[][] = [];
    const unsubscribe = catalog.subscribe((change) => {
      changes.push([...change.removed]);
    });
    const definitions = catalog.definitions.filter(
      (definition) => definition.spec.name !== "system.notify",
    );

    const replacement = catalog.replaceDefinitions(definitions);

    expect(replacement).toMatchObject({
      changed: true,
      added: [],
      removed: ["system.notify"],
      updated: [],
    });
    expect(catalog.manifest.digest).not.toBe(originalManifest.digest);
    expect(
      catalog.manifest.tools.some((tool) => tool.name === "system.notify"),
    ).toBe(false);
    expect(changes).toEqual([["system.notify"]]);

    const unchanged = catalog.replaceDefinitions(definitions);
    expect(unchanged.changed).toBe(false);
    expect(unchanged.manifest).toBe(catalog.manifest);
    expect(changes).toHaveLength(1);
    unsubscribe();
  });

  it("rejects duplicate replacement definitions without mutating the active catalog", async () => {
    const catalog = await createCatalog();
    const originalManifest = catalog.manifest;
    const duplicate = catalog.definitions[0];
    expect(duplicate).toBeDefined();

    expect(() =>
      catalog.replaceDefinitions([...catalog.definitions, duplicate!]),
    ).toThrow(/Duplicate tool definition/u);
    expect(catalog.manifest).toBe(originalManifest);
  });
});
