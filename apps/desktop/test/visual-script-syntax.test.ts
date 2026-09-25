import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const files = [
  "visual-test.ts",
  "visual-task-verification.ts",
  "visual-project-workspace-verification.ts",
  "visual-overview-verification.ts",
];

describe("static JavaScript embedded in visual verification", () => {
  it.each(files)("parses renderer scripts in %s without executing them", (file) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let parsed = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "executeJavaScript") {
        const argument = node.arguments[0];
        // Dynamic templates require rendered tests; static strings can be
        // checked here even though TypeScript does not parse their contents.
        if (argument !== undefined && (ts.isNoSubstitutionTemplateLiteral(argument)
          || ts.isStringLiteral(argument))) {
          const line = source.getLineAndCharacterOfPosition(argument.getStart()).line + 1;
          expect(() => new Script(argument.text, { filename: `${file}:${line}` })).not.toThrow();
          parsed += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(parsed).toBeGreaterThan(0);
  });
});
