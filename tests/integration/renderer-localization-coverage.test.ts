import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as ts from "typescript";

import { localizeSubtree } from "../../apps/desktop/src/renderer/localization.js";
import { PHRASES } from "../../apps/desktop/src/renderer/localization-messages.js";
import { V2_PHRASES } from "../../apps/desktop/src/renderer/v2-localization.js";
import { permissionProfileDisplay } from "../../apps/desktop/src/renderer/connection-presentation.js";

const RENDERER_ROOT = resolve(
  process.cwd(),
  "apps",
  "desktop",
  "src",
  "renderer",
);
const LOCALIZATION_PATH = resolve(RENDERER_ROOT, "localization.ts");
const CORE_VIEW_FILES = [
  "view-overview.ts",
  "view-agent.ts",
  "view-runs.ts",
  "view-tasks.ts",
  "view-terminal.ts",
  "view-python.ts",
  "view-browser.ts",
  "view-computer.ts",
  "view-workflows.ts",
  "view-settings.ts",
  "view-gemini-connection.ts",
  "view-approvals-audit.ts",
  "workflow-step-presentation.ts",
  "task-detail-panels.ts",
] as const;

interface StaticCandidate {
  readonly file: string;
  readonly kind: "text" | "attribute";
  readonly value: string;
}

function normalizeMarkupText(value: string): string {
  return value.replaceAll("&amp;", "&").replace(/\s+/gu, " ").trim();
}

function sourceTree(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(resolve(RENDERER_ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
}

function approvalCopyCatalog(): {
  readonly phrases: readonly (readonly [string, string])[];
  readonly labelSources: ReadonlyMap<string, string>;
} {
  const phrases: (readonly [string, string])[] = [];
  const labelSources = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "copy") {
      const [english, chinese] = node.arguments;
      if (english !== undefined && chinese !== undefined && ts.isStringLiteralLike(english) && ts.isStringLiteralLike(chinese)) {
        phrases.push([english.text, chinese.text]);
      }
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 3) {
      const [id, english, chinese] = node.elements;
      if (id !== undefined && english !== undefined && chinese !== undefined &&
          ts.isStringLiteralLike(id) && id.text.startsWith("v2-") &&
          ts.isStringLiteralLike(english) && ts.isStringLiteralLike(chinese)) {
        labelSources.set(id.text, english.text);
        phrases.push([english.text, chinese.text]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceTree("approvals-audit-controller.ts"));
  return { phrases, labelSources };
}

function staticCandidates(file: string, labelSources?: ReadonlyMap<string, string>): readonly StaticCandidate[] {
  const markup: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTemplateExpression(node)) {
      markup.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${expression}"));
    } else if (ts.isStringLiteralLike(node)) {
      markup.push(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceTree(file));
  const candidates: StaticCandidate[] = [];
  for (const source of markup) {
    for (const match of source.matchAll(/<([^<>]+)>([^<>${}]+)(?=<)/gu)) {
      const id = /(?:^|\s)id="([^"]+)"/u.exec(match[1] ?? "")?.[1];
      // This controller owns its labels and replaces initial markup by element ID.
      const value = normalizeMarkupText((id === undefined ? undefined : labelSources?.get(id)) ?? match[2] ?? "");
      if (/[A-Za-z]/u.test(value) && !/[{};]/u.test(value)) candidates.push({ file, kind: "text", value });
    }
    for (const match of source.matchAll(/(?:aria-label|title|placeholder)="([^"]+)"/gu)) {
      const value = normalizeMarkupText(match[1] ?? "");
      if (/[A-Za-z]/u.test(value) && !value.includes("${")) candidates.push({ file, kind: "attribute", value });
    }
  }
  return candidates;
}

function isTechnicalOrDynamic(value: string): boolean {
  const patterns = [
    /^\d+ (?:(?:active )?tasks?|sessions?|runs?|receipts?|processes?|elements?|blocked requests?|steps?|running)$/u,
    /^\d+ active · \d+ failed$/u,
    /^\d+ B$/u,
    /^(?:https?|127\.0\.0\.1|[A-Z]:\\|(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.(?:py|exe))/u,
    /^(?:L[1-4]|CPU|PID|SHA-256|MCP|Gateway|Tunnel ID|Runtime key|CPython|Python|English|Sovereign|Code Runtime|X|Y|ENTER|TAB|ESC|F5|stdout|stderr)/u,
  ] as const;
  return patterns.some((pattern) => pattern.test(value));
}

describe("renderer localization coverage", () => {
  const localizationSource = readFileSync(LOCALIZATION_PATH, "utf8");
  // PHRASES already includes the task-board and connection catalogs, as at runtime.
  const phrases = [...PHRASES, ...V2_PHRASES];
  const approvalCopy = approvalCopyCatalog();
  const translations = new Map<string, Set<string>>();
  for (const [english, chinese] of phrases) {
    const values = translations.get(english) ?? new Set<string>();
    values.add(chinese);
    translations.set(english, values);
  }

  it("localizes task step state and relative update copy reversibly", () => {
    vi.stubGlobal("Node", { TEXT_NODE: 3 });
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    try {
      for (const [english, chinese] of [
        ["pending", "待处理"],
        ["running", "运行中"],
        ["succeeded", "成功"],
        ["failed", "失败"],
        ["skipped", "已跳过"],
        ["Updated 2 minutes ago", "更新于 2 分钟前"],
        ["CPython 3.11.9 available", "CPython 3.11.9 可用"],
        ["Python run succeeded", "Python 执行 · 成功"],
        ["Python run cancelling", "Python 执行 · 正在取消"],
        ["1920×1080 desktop", "1920×1080 桌面"],
      ] as const) {
        const textNode = {
          nodeType: 3,
          nodeValue: english,
          parentElement: { closest: () => null },
        };
        localizeSubtree(textNode as unknown as Node, "zh-CN");
        expect(textNode.nodeValue).toBe(chinese);
        localizeSubtree(textNode as unknown as Node, "en");
        expect(textNode.nodeValue).toBe(english);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("localizes current connection and permission copy reversibly", () => {
    vi.stubGlobal("Node", { TEXT_NODE: 3 });
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    try {
      for (const [english, chinese] of [
        ["Connector not installed", "连接器未安装"],
        ["Tunnel connecting", "隧道正在连接"],
        ["Saved securely · leave blank to reuse", "已安全保存 · 留空即可复用"],
        [
          "Saved with Windows DPAPI · http://proxy.example.test:8080. Only OpenAI control-plane requests use it; local MCP remains direct.",
          "已使用 Windows DPAPI 保存 · http://proxy.example.test:8080。仅 OpenAI 控制平面请求使用此代理；本机 MCP 保持直连。",
        ],
        [
          "Saved with Windows DPAPI · https://backup-proxy.example.test:8443. Use an independent service or exit when possible.",
          "已使用 Windows DPAPI 保存 · https://backup-proxy.example.test:8443。请尽可能使用独立服务或独立出口。",
        ],
        [
          "Primary proxy · http://proxy.example.test:8080 · 0 switches.",
          "主要代理 · http://proxy.example.test:8080 · 已切换 0 次。",
        ],
        [
          "Saved bridge · https://sovereign.example.test/mcp",
          "已保存网桥 · https://sovereign.example.test/mcp",
        ],
        [
          "Fallback MCP bundle target · https://sovereign.example.test/mcp",
          "备用 MCP 连接包目标 · https://sovereign.example.test/mcp",
        ],
        ["Gemini listener did not start.", "Gemini 监听未启动。"],
        ["Allow connected web agent to run terminal.session.create?", "允许已连接的网页 Agent 执行 terminal.session.create 吗？"],
        ["L3 Consequential · files.write", "L3 高影响 · files.write"],
        [
          permissionProfileDisplay("consequential"),
          "高风险操作需确认 · L3",
        ],
      ] as const) {
        const textNode = {
          nodeType: 3,
          nodeValue: english,
          parentElement: { closest: () => null },
        };
        localizeSubtree(textNode as unknown as Node, "zh-CN");
        expect(textNode.nodeValue).toBe(chinese);
        localizeSubtree(textNode as unknown as Node, "en");
        expect(textNode.nodeValue).toBe(english);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps English source strings instead of reverse-translating Chinese values", () => {
    expect(localizationSource).not.toContain("ZH_TO_EN");
    expect(localizationSource).toContain("TEXT_SOURCES");
    expect(localizationSource).toContain("ATTRIBUTE_SOURCES");
  });

  it("does not define conflicting translations for one English source", () => {
    const conflicts = [...translations.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([english, values]) => ({ english, chinese: [...values] }));
    expect(conflicts).toEqual([]);
  });

  it("maps static user-facing copy in the core desktop views", () => {
    const mapped = new Set(translations.keys());
    const approvalMapped = new Set(approvalCopy.phrases.map(([english]) => english));
    const unmapped = new Map<string, StaticCandidate>();
    for (const file of CORE_VIEW_FILES) {
      const scopedLabels = file === "view-approvals-audit.ts" ? approvalCopy.labelSources : undefined;
      for (const candidate of staticCandidates(file, scopedLabels)) {
        if (
          mapped.has(candidate.value) ||
          (file === "view-approvals-audit.ts" && approvalMapped.has(candidate.value)) ||
          isTechnicalOrDynamic(candidate.value)
        ) {
          continue;
        }
        unmapped.set(`${candidate.kind}\0${candidate.value}`, candidate);
      }
    }
    expect([...unmapped.values()]).toEqual([]);
  });
});
