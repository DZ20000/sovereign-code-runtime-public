import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryAuditStore, PolicyEngine } from "@sovereign/runtime-core";
import {
  ToolCatalog,
  createBuiltinTools,
  createDeveloperEssentialsToolPack,
} from "@sovereign/toolkit";
import { WindowsAdapter } from "@sovereign/windows-adapter";

import {
  TOOL_PACK_CONFIG_SCHEMA_VERSION,
  ToolPackManager,
  type ToolPackStatus,
} from "../src/tool-pack-manager.js";

interface Fixture {
  readonly root: string;
  readonly adapter: WindowsAdapter;
  readonly audit: MemoryAuditStore;
  readonly external: ToolCatalog;
  readonly internal: ToolCatalog;
  readonly manager: ToolPackManager;
  readonly configPath: string;
}

const fixtures: Fixture[] = [];

interface FixtureOptions {
  readonly watch?: boolean;
  readonly onChanged?: (status: ToolPackStatus) => void;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "scr-tool-packs-"));
  const policy = new PolicyEngine();
  const audit = new MemoryAuditStore();
  const adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy,
    audit,
  });
  const baseDefinitions = createBuiltinTools(adapter);
  const external = new ToolCatalog(baseDefinitions, policy, "0.1.0");
  const internal = new ToolCatalog(baseDefinitions, policy, "0.1.0");
  const configPath = join(root, ".scr", "tool-packs.json");
  const manager = new ToolPackManager({
    configPath,
    baseDefinitions,
    packs: [createDeveloperEssentialsToolPack(adapter)],
    catalogs: [external, internal],
    audit,
    watch: options.watch ?? false,
    debounceMs: 25,
    pollMs: 250,
    ...(options.onChanged === undefined
      ? {}
      : { onChanged: options.onChanged }),
  });
  const fixture = {
    root,
    adapter,
    audit,
    external,
    internal,
    manager,
    configPath,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.manager.close();
    await fixture.adapter.shutdown();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("tool-pack manager", () => {
  it("installs default packs and atomically updates every catalog", async () => {
    const fixture = await createFixture();

    const initial = await fixture.manager.start();
    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      schemaVersion: string;
      enabled: string[];
    };

    expect(config).toEqual({
      schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
      enabled: ["developer-essentials"],
    });
    expect(initial.enabled).toEqual(["developer-essentials"]);
    expect(initial.generation).toBe(1);
    expect(initial.lastError).toBeNull();
    expect(fixture.external.manifest.digest).toBe(
      fixture.internal.manifest.digest,
    );
    expect(fixture.external.manifest.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "system.capabilities",
        "files.read_lines",
        "workspace.context",
        "workspace.snapshot",
        "git.summary",
        "git.show",
        "git.blame",
        "git.branches",
        "git.tags",
        "git.worktrees",
        "git.files",
        "validation.verify",
        "validation.release_check",
      ]),
    );

    await writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
          enabled: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const disabled = await fixture.manager.reload();

    expect(disabled.enabled).toEqual([]);
    expect(disabled.generation).toBe(2);
    expect(disabled.toolCount).toBe(
      initial.toolCount -
        createDeveloperEssentialsToolPack(fixture.adapter).definitions.length,
    );
    expect(fixture.external.manifest.digest).toBe(
      fixture.internal.manifest.digest,
    );
    expect(
      fixture.external.manifest.tools.some(
        (tool) => tool.name === "system.capabilities",
      ),
    ).toBe(false);
    expect(fixture.audit.list(10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "system.tool_packs",
          operation: "tool_pack_reload",
          outcome: "succeeded",
        }),
      ]),
    );
  });

  it("automatically reloads a changed configuration without an explicit call", async () => {
    let resolveChange!: (status: ToolPackStatus) => void;
    const changed = new Promise<ToolPackStatus>((resolveStatus) => {
      resolveChange = resolveStatus;
    });
    const fixture = await createFixture({
      watch: true,
      onChanged(status): void {
        if (status.generation >= 2) {
          resolveChange(status);
        }
      },
    });
    await fixture.manager.start();

    await writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
          enabled: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const reloaded = await Promise.race([
      changed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(new Error("Timed out waiting for the tool-pack watcher.")),
          5_000,
        );
      }),
    ]);

    expect(reloaded.enabled).toEqual([]);
    expect(reloaded.generation).toBe(2);
    expect(
      fixture.external.manifest.tools.some(
        (tool) => tool.name === "git.summary",
      ),
    ).toBe(false);
  });

  it("keeps the last valid catalogs when configuration is invalid", async () => {
    const fixture = await createFixture();
    const initial = await fixture.manager.start();
    const initialDigest = initial.manifestDigest;

    await writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
          enabled: ["unknown-pack"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const invalid = await fixture.manager.reload();

    expect(invalid.manifestDigest).toBe(initialDigest);
    expect(invalid.enabled).toEqual(["developer-essentials"]);
    expect(invalid.lastError).toMatch(/Unknown tool-pack id/u);
    expect(fixture.external.manifest.digest).toBe(initialDigest);
    expect(fixture.internal.manifest.digest).toBe(initialDigest);
    expect(fixture.audit.list(1)[0]).toMatchObject({
      toolName: "system.tool_packs",
      operation: "tool_pack_reload",
      outcome: "failed",
      errorCode: "INVALID_INPUT",
    });
  });

  it("configures only installed packs and persists a canonical registry", async () => {
    const fixture = await createFixture();
    await fixture.manager.start();

    const disabled = await fixture.manager.configure([], "chatgpt-web");
    const persisted = await readFile(fixture.configPath, "utf8");
    const registryEntries = await readdir(join(fixture.root, ".scr"));

    expect(disabled.enabled).toEqual([]);
    expect(disabled.generation).toBe(2);
    expect(JSON.parse(persisted)).toEqual({
      schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
      enabled: [],
    });
    expect(registryEntries).toEqual(["tool-packs.json"]);
    expect(fixture.audit.list(20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: "chatgpt-web",
          toolName: "system.tool_packs",
          operation: "tool_pack_reload",
          outcome: "succeeded",
        }),
      ]),
    );
    await expect(fixture.manager.configure(["unknown-pack"])).rejects.toThrow(
      /Unknown tool-pack id/u,
    );
    expect(await readFile(fixture.configPath, "utf8")).toBe(persisted);
    expect(fixture.manager.status().enabled).toEqual([]);
  });

  it("deduplicates repeated read failures and recovers after the registry returns", async () => {
    const fixture = await createFixture();
    await fixture.manager.start();
    await rm(fixture.configPath, { force: true });

    const first = await fixture.manager.reload();
    const firstFailureCount = fixture.audit
      .list(100)
      .filter(
        (receipt) =>
          receipt.toolName === "system.tool_packs" &&
          receipt.operation === "tool_pack_reload" &&
          receipt.outcome === "failed",
      ).length;
    const second = await fixture.manager.reload();
    const secondFailureCount = fixture.audit
      .list(100)
      .filter(
        (receipt) =>
          receipt.toolName === "system.tool_packs" &&
          receipt.operation === "tool_pack_reload" &&
          receipt.outcome === "failed",
      ).length;

    expect(first.lastError).toMatch(/tool-packs\.json/u);
    expect(second.lastError).toBe(first.lastError);
    expect(firstFailureCount).toBe(1);
    expect(secondFailureCount).toBe(firstFailureCount);

    const restored = await fixture.manager.configure(["developer-essentials"]);
    expect(restored.lastError).toBeNull();
    expect(restored.enabled).toEqual(["developer-essentials"]);
    expect(restored.generation).toBe(1);
  });

  it("does not let a status listener roll back an accepted catalog", async () => {
    const fixture = await createFixture({
      onChanged(): void {
        throw new Error("synthetic listener failure");
      },
    });

    await expect(fixture.manager.start()).resolves.toMatchObject({
      enabled: ["developer-essentials"],
      generation: 1,
      lastError: null,
    });
    expect(
      fixture.external.manifest.tools.some(
        (tool) => tool.name === "system.capabilities",
      ),
    ).toBe(true);
  });

  it("rejects reload and configuration after close", async () => {
    const fixture = await createFixture();
    await fixture.manager.start();
    await fixture.manager.close();

    await expect(fixture.manager.reload()).rejects.toThrow(/closed/u);
    await expect(
      fixture.manager.configure(["developer-essentials"]),
    ).rejects.toThrow(/closed/u);
  });
});
