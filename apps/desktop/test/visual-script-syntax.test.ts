import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const files = [
  "visual-test.ts", "visual-task-verification.ts", "visual-task-workbench-verification.ts",
  "visual-project-workspace-verification.ts", "visual-overview-verification.ts",
  "visual-agent-verification.ts", "visual-gemini-verification.ts", "visual-shared-controls-verification.ts",
  "visual-interaction-verification.ts", "visual-navigation.ts", "visual-matrix-verification.ts",
  "visual-permission-verification.ts", "visual-history-verification.ts", "visual-approval-verification.ts",
  "visual-preview-fixture.ts",
];

function staticScript(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left=staticScript(expression.left), right=staticScript(expression.right);
    if (left !== undefined && right !== undefined) return left+right;
  }
  return undefined;
}

describe("static JavaScript embedded in visual verification", () => {
  it.each(files)("parses renderer scripts in %s without executing them", (file) => {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let parsed=0;
    const visit=(node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const direct=ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==="executeJavaScript";
        const evaluate=ts.isIdentifier(node.expression)&&node.expression.text==="evaluate";
        const predicate=ts.isIdentifier(node.expression)&&node.expression.text==="waitForVisualState";
        const expression=direct||evaluate ? node.arguments[0] : predicate ? node.arguments[1] : undefined;
        const text=staticScript(expression);
        // Dynamic values are checked by the rendered pass. Constant concatenations
        // and evaluate helpers are parsed here without Electron or any IPC.
        if (text !== undefined) {
          const line=source.getLineAndCharacterOfPosition(expression!.getStart()).line+1;
          expect(() => new Script(text,{filename:`${file}:${line}`})).not.toThrow();
          parsed+=1;
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
    expect(parsed).toBeGreaterThan(0);
  });
});
