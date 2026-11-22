import { z } from "zod";

import {
  defineTool,
  type RuntimeToolPack,
} from "@sovereign/toolkit";

import { type SemanticCodeProvider } from "./serena-manager.js";

const workspaceId = z.string().min(1).max(128);
const relativePath = z.string().min(1).max(4_096);
const optionalRelativePath = z.string().max(4_096);
const namePath = z.string().min(1).max(1_000);
const maxChars = z.number().int().min(1_024).max(100_000).default(50_000);

const semanticMetadata = {
  version: "1.0.0",
  category: "code",
  requiredCapabilities: ["workspace.read", "files.read", "search.read"],
  sideEffect: "process",
  destructive: false,
  permissionLevel: "observe",
  approvalMode: "none",
} as const;

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
          ...semanticMetadata,
          name: "code.semantic.status",
          title: "Semantic provider status",
          description:
            "Start or probe the isolated read-only Serena sidecar and return its bounded status and exact reviewed tool allowlist.",
          requiredCapabilities: ["system.read", "workspace.read"],
        },
        { workspaceId },
        () => provider.probe(),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          ...semanticMetadata,
          name: "code.symbols",
          title: "File symbol overview",
          description:
            "Return a compact semantic symbol overview for one contained source file through the reviewed Serena read-only facade.",
        },
        {
          workspaceId,
          path: relativePath,
          depth: z.number().int().min(0).max(3).default(0),
          maxChars,
        },
        (_context, input) =>
          provider.call("get_symbols_overview", {
            relative_path: input.path,
            depth: input.depth,
            max_answer_chars: input.maxChars,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          ...semanticMetadata,
          name: "code.symbol.find",
          title: "Find semantic symbol",
          description:
            "Find symbols by Serena name-path pattern, optionally restricted to one contained file or directory.",
        },
        {
          workspaceId,
          namePathPattern: namePath,
          path: optionalRelativePath.default(""),
          depth: z.number().int().min(0).max(3).default(0),
          includeBody: z.boolean().default(false),
          includeInfo: z.boolean().default(false),
          substringMatching: z.boolean().default(false),
          maxMatches: z.number().int().min(1).max(100).default(20),
          maxChars,
        },
        (_context, input) =>
          provider.call("find_symbol", {
            name_path_pattern: input.namePathPattern,
            relative_path: input.path,
            depth: input.depth,
            include_body: input.includeBody,
            include_info: input.includeInfo,
            substring_matching: input.substringMatching,
            max_matches: input.maxMatches,
            max_answer_chars: input.maxChars,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          ...semanticMetadata,
          name: "code.references",
          title: "Find symbol references",
          description:
            "Find semantic references to one symbol identified by name path and contained source file.",
        },
        {
          workspaceId,
          namePath,
          path: relativePath,
          maxChars,
        },
        (_context, input) =>
          provider.call("find_referencing_symbols", {
            name_path: input.namePath,
            relative_path: input.path,
            max_answer_chars: input.maxChars,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          ...semanticMetadata,
          name: "code.implementations",
          title: "Find symbol implementations",
          description:
            "Find semantic implementations of one symbol identified by name path and contained source file.",
        },
        {
          workspaceId,
          namePath,
          path: relativePath,
          includeInfo: z.boolean().default(false),
          maxChars,
        },
        (_context, input) =>
          provider.call("find_implementations", {
            name_path: input.namePath,
            relative_path: input.path,
            include_info: input.includeInfo,
            max_answer_chars: input.maxChars,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          ...semanticMetadata,
          name: "code.definition",
          title: "Find declaration from usage",
          description:
            "Resolve a declaration from one bounded regex capture in a contained source file, optionally within a named containing symbol.",
        },
        {
          workspaceId,
          path: relativePath,
          regex: z.string().min(3).max(1_000),
          containingSymbolNamePath: namePath.optional(),
          includeBody: z.boolean().default(false),
          includeInfo: z.boolean().default(false),
        },
        (_context, input) =>
          provider.call("find_declaration", {
            relative_path: input.path,
            regex: input.regex,
            containing_symbol_name_path: input.containingSymbolNamePath ?? null,
            include_body: input.includeBody,
            include_info: input.includeInfo,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          ...semanticMetadata,
          name: "code.diagnostics",
          title: "File diagnostics",
          description:
            "Return bounded LSP diagnostics for one contained source file, grouped by severity and semantic symbol.",
        },
        {
          workspaceId,
          path: relativePath,
          startLine: z.number().int().min(0).max(1_000_000).default(0),
          endLine: z.number().int().min(-1).max(1_000_000).default(-1),
          minSeverity: z.number().int().min(1).max(4).default(4),
          maxChars,
        },
        (_context, input) =>
          provider.call("get_diagnostics_for_file", {
            relative_path: input.path,
            start_line: input.startLine,
            end_line: input.endLine,
            min_severity: input.minSeverity,
            max_answer_chars: input.maxChars,
          }),
        (input) => input.workspaceId,
      ),
    ],
  };
}
