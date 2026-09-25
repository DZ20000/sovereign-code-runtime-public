import { describe, expect, it, vi } from "vitest";

import {
  CAPABILITIES,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import { ToolCatalog } from "@sovereign/toolkit";

import { createSemanticCodeToolPack } from "../src/semantic-code-pack.js";
import {
  SERENA_READ_ONLY_TOOLS,
  SERENA_SEMANTIC_STATUS_SCHEMA_VERSION,
  type SemanticCodeProvider,
  type SerenaReadOnlyToolName,
  type SerenaSemanticStatus,
} from "../src/serena-manager.js";

function provider(): SemanticCodeProvider & {
  readonly callMock: ReturnType<typeof vi.fn>;
} {
  const status: SerenaSemanticStatus = {
    schemaVersion: SERENA_SEMANTIC_STATUS_SCHEMA_VERSION,
    provider: "serena",
    state: "ready",
    executable: "serena.exe",
    executableVersion: "1.7.0",
    expectedExecutableVersion: "1.7.0",
    workspaceFingerprint: "a".repeat(64),
    allowedTools: [...SERENA_READ_ONLY_TOOLS],
    processId: 123,
    startedAt: "2026-08-22T00:00:00.000Z",
    lastError: null,
  };
  const callMock = vi.fn(
    async (
      toolName: SerenaReadOnlyToolName,
      input: Readonly<Record<string, unknown>>,
    ) => ({ toolName, input }),
  );
  return {
    callMock,
    status: () => status,
    probe: async () => status,
    call: callMock,
    deactivate: async () => undefined,
    stop: async () => undefined,
  };
}

describe("semantic code tool pack", () => {
  it("exposes only reviewed read-only Serena facades", async () => {
    const semantic = provider();
    const pack = createSemanticCodeToolPack(semantic);
    const catalog = new ToolCatalog(
      pack.definitions,
      new PolicyEngine(),
      "test",
    );
    const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    expect(pack).toMatchObject({
      id: "semantic-code",
      version: "1.0.0",
      enabledByDefault: false,
    });
    expect(pack.definitions.map((definition) => definition.spec.name)).toEqual([
      "code.semantic.status",
      "code.symbols",
      "code.symbol.find",
      "code.references",
      "code.implementations",
      "code.definition",
      "code.diagnostics",
    ]);
    expect(
      pack.definitions.every(
        (definition) =>
          definition.spec.permissionLevel === "observe" &&
          definition.spec.destructive === false,
      ),
    ).toBe(true);

    await expect(
      catalog.invoke(
        "code.symbol.find",
        { principal },
        {
          workspaceId: "workspace",
          namePathPattern: "ToolCatalog",
          path: "packages/toolkit/src/index.ts",
          maxMatches: 5,
        },
      ),
    ).resolves.toEqual({
      toolName: "find_symbol",
      input: {
        name_path_pattern: "ToolCatalog",
        relative_path: "packages/toolkit/src/index.ts",
        depth: 0,
        include_body: false,
        include_info: false,
        substring_matching: false,
        max_matches: 5,
        max_answer_chars: 50_000,
      },
    });
    expect(semantic.callMock).toHaveBeenCalledTimes(1);
  });

  it("maps diagnostics and references to their exact Serena tools", async () => {
    const semantic = provider();
    const catalog = new ToolCatalog(
      createSemanticCodeToolPack(semantic).definitions,
      new PolicyEngine(),
      "test",
    );
    const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);

    await catalog.invoke(
      "code.references",
      { principal },
      {
        workspaceId: "workspace",
        namePath: "ToolCatalog/invoke",
        path: "packages/toolkit/src/index.ts",
      },
    );
    await catalog.invoke(
      "code.diagnostics",
      { principal },
      {
        workspaceId: "workspace",
        path: "packages/toolkit/src/index.ts",
        minSeverity: 2,
      },
    );

    expect(semantic.callMock.mock.calls).toEqual([
      [
        "find_referencing_symbols",
        {
          name_path: "ToolCatalog/invoke",
          relative_path: "packages/toolkit/src/index.ts",
          max_answer_chars: 50_000,
        },
      ],
      [
        "get_diagnostics_for_file",
        {
          relative_path: "packages/toolkit/src/index.ts",
          start_line: 0,
          end_line: -1,
          min_severity: 2,
          max_answer_chars: 50_000,
        },
      ],
    ]);
  });
});
