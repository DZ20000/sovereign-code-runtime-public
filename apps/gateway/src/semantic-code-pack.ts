import { z } from "zod";

import {
  defineTool,
  objectSchema,
  type RuntimeToolPack,
} from "@sovereign/toolkit";

import { type SemanticCodeProvider } from "./serena-manager.js";

const workspaceId = z.string().min(1).max(128);
const relativePath = z.string().min(1).max(4_096);
const optionalRelativePath = z.string().max(4_096);
const namePath = z.string().min(1).max(1_000);
const maxChars = z.number().int().min(1_024).max(100_000);

function semanticCapabilities(): readonly [
  "workspace.read",
  "files.read",
  "search.read",
] {
  return ["workspace.read", "files.read", "search.read"];
}

export function createSemanticCodeToolPack(
  provider: SemanticCodeProvider,
): RuntimeToolPack {
  return {
    id: "semantic-code",
    version: "1.0.0",
    title: "Semantic code intelligence",
    description:
      "Reviewed read-only Serena/LSP facades for symbols, definitions, references, implementations, and file diagnostics.",
    enabledByDefault: false,
    definitions: [
      defineTool(
        {
          name: "code.semantic.status",
          version: "1.0.0",
          title: "Semantic provider status",
          description:
            "Start or probe the isolated read-only Serena sidecar and return its bounded status and exact reviewed tool allowlist.",
          category: "code",
          requiredCapabilities: ["system.read", "workspace.read"],
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          }),
        },
        { workspaceId },
        () => provider.probe(),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "code.symbols",
          version: "1.0.0",
          title: "File symbol overview",
          description:
            "Return a compact semantic symbol overview for one contained source file through the reviewed Serena read-only facade.",
          category: "code",
          requiredCapabilities: semanticCapabilities(),
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1, maxLength: 128 },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              depth: { type: "integer", minimum: 0, maximum: 3, default: 0 },
              maxChars: {
                type: "integer",
                minimum: 1_024,
                maximum: 100_000,
                default: 50_000,
              },
            },
            ["workspaceId", "path"],
          ),
        },
        {
          workspaceId,
          path: relativePath,
          depth: z.number().int().min(0).max(3).optional(),
          maxChars: maxChars.optional(),
        },
        (_context, input) =>
          provider.call("get_symbols_overview", {
            relative_path: input.path,
            depth: input.depth ?? 0,
            max_answer_chars: input.maxChars ?? 50_000,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "code.symbol.find",
          version: "1.0.0",
          title: "Find semantic symbol",
          description:
            "Find symbols by Serena name-path pattern, optionally restricted to one contained file or directory.",
          category: "code",
          requiredCapabilities: semanticCapabilities(),
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1, maxLength: 128 },
              namePathPattern: {
                type: "string",
                minLength: 1,
                maxLength: 1_000,
              },
              path: { type: "string", maxLength: 4_096, default: "" },
              depth: { type: "integer", minimum: 0, maximum: 3, default: 0 },
              includeBody: { type: "boolean", default: false },
              includeInfo: { type: "boolean", default: false },
              substringMatching: { type: "boolean", default: false },
              maxMatches: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
              maxChars: {
                type: "integer",
                minimum: 1_024,
                maximum: 100_000,
                default: 50_000,
              },
            },
            ["workspaceId", "namePathPattern"],
          ),
        },
        {
          workspaceId,
          namePathPattern: namePath,
          path: optionalRelativePath.optional(),
          depth: z.number().int().min(0).max(3).optional(),
          includeBody: z.boolean().optional(),
          includeInfo: z.boolean().optional(),
          substringMatching: z.boolean().optional(),
          maxMatches: z.number().int().min(1).max(100).optional(),
          maxChars: maxChars.optional(),
        },
        (_context, input) =>
          provider.call("find_symbol", {
            name_path_pattern: input.namePathPattern,
            relative_path: input.path ?? "",
            depth: input.depth ?? 0,
            include_body: input.includeBody ?? false,
            include_info: input.includeInfo ?? false,
            substring_matching: input.substringMatching ?? false,
            max_matches: input.maxMatches ?? 20,
            max_answer_chars: input.maxChars ?? 50_000,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "code.references",
          version: "1.0.0",
          title: "Find symbol references",
          description:
            "Find semantic references to one symbol identified by name path and contained source file.",
          category: "code",
          requiredCapabilities: semanticCapabilities(),
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1, maxLength: 128 },
              namePath: { type: "string", minLength: 1, maxLength: 1_000 },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              maxChars: {
                type: "integer",
                minimum: 1_024,
                maximum: 100_000,
                default: 50_000,
              },
            },
            ["workspaceId", "namePath", "path"],
          ),
        },
        {
          workspaceId,
          namePath,
          path: relativePath,
          maxChars: maxChars.optional(),
        },
        (_context, input) =>
          provider.call("find_referencing_symbols", {
            name_path: input.namePath,
            relative_path: input.path,
            max_answer_chars: input.maxChars ?? 50_000,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "code.implementations",
          version: "1.0.0",
          title: "Find symbol implementations",
          description:
            "Find semantic implementations of one symbol identified by name path and contained source file.",
          category: "code",
          requiredCapabilities: semanticCapabilities(),
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1, maxLength: 128 },
              namePath: { type: "string", minLength: 1, maxLength: 1_000 },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              includeInfo: { type: "boolean", default: false },
              maxChars: {
                type: "integer",
                minimum: 1_024,
                maximum: 100_000,
                default: 50_000,
              },
            },
            ["workspaceId", "namePath", "path"],
          ),
        },
        {
          workspaceId,
          namePath,
          path: relativePath,
          includeInfo: z.boolean().optional(),
          maxChars: maxChars.optional(),
        },
        (_context, input) =>
          provider.call("find_implementations", {
            name_path: input.namePath,
            relative_path: input.path,
            include_info: input.includeInfo ?? false,
            max_answer_chars: input.maxChars ?? 50_000,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "code.definition",
          version: "1.0.0",
          title: "Find declaration from usage",
          description:
            "Resolve a declaration from one bounded regex capture in a contained source file, optionally within a named containing symbol.",
          category: "code",
          requiredCapabilities: semanticCapabilities(),
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1, maxLength: 128 },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              regex: { type: "string", minLength: 3, maxLength: 1_000 },
              containingSymbolNamePath: {
                type: "string",
                minLength: 1,
                maxLength: 1_000,
              },
              includeBody: { type: "boolean", default: false },
              includeInfo: { type: "boolean", default: false },
            },
            ["workspaceId", "path", "regex"],
          ),
        },
        {
          workspaceId,
          path: relativePath,
          regex: z.string().min(3).max(1_000),
          containingSymbolNamePath: namePath.optional(),
          includeBody: z.boolean().optional(),
          includeInfo: z.boolean().optional(),
        },
        (_context, input) =>
          provider.call("find_declaration", {
            relative_path: input.path,
            regex: input.regex,
            containing_symbol_name_path: input.containingSymbolNamePath ?? null,
            include_body: input.includeBody ?? false,
            include_info: input.includeInfo ?? false,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "code.diagnostics",
          version: "1.0.0",
          title: "File diagnostics",
          description:
            "Return bounded LSP diagnostics for one contained source file, grouped by severity and semantic symbol.",
          category: "code",
          requiredCapabilities: semanticCapabilities(),
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1, maxLength: 128 },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              startLine: {
                type: "integer",
                minimum: 0,
                maximum: 1_000_000,
                default: 0,
              },
              endLine: {
                type: "integer",
                minimum: -1,
                maximum: 1_000_000,
                default: -1,
              },
              minSeverity: {
                type: "integer",
                minimum: 1,
                maximum: 4,
                default: 4,
              },
              maxChars: {
                type: "integer",
                minimum: 1_024,
                maximum: 100_000,
                default: 50_000,
              },
            },
            ["workspaceId", "path"],
          ),
        },
        {
          workspaceId,
          path: relativePath,
          startLine: z.number().int().min(0).max(1_000_000).optional(),
          endLine: z.number().int().min(-1).max(1_000_000).optional(),
          minSeverity: z.number().int().min(1).max(4).optional(),
          maxChars: maxChars.optional(),
        },
        (_context, input) =>
          provider.call("get_diagnostics_for_file", {
            relative_path: input.path,
            start_line: input.startLine ?? 0,
            end_line: input.endLine ?? -1,
            min_severity: input.minSeverity ?? 4,
            max_answer_chars: input.maxChars ?? 50_000,
          }),
        (input) => input.workspaceId,
      ),
    ],
  };
}
