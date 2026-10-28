import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { jsonLanguage } from "@codemirror/lang-json";
import { classHighlighter, highlightTree } from "@lezer/highlight";

// Exercise package interoperability without connecting to the live desktop.
describe("editor dependency compatibility", () => {
  it("shares state extensions and preserves literal Unicode edits through undo and redo", () => {
    let state = EditorState.create({
      doc: "left TOKEN right",
      extensions: [history(), EditorView.lineWrapping, EditorState.allowMultipleSelections.of(true)],
    });
    const target = {
      get state() { return state; },
      dispatch(transaction: Transaction) { state = transaction.state; },
    };
    target.dispatch(state.update({ changes: { from: 5, to: 10, insert: "$& 中文🚀" } }));
    expect(state.doc.toString()).toBe("left $& 中文🚀 right");
    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe("left TOKEN right");
    expect(redo(target)).toBe(true);
    expect(state.doc.toString()).toBe("left $& 中文🚀 right");
    target.dispatch(state.update({ selection: EditorSelection.create([
      EditorSelection.cursor(0), EditorSelection.cursor(state.doc.length),
    ]) }));
    expect(state.selection.ranges).toHaveLength(2);
  });

  it("keeps language parsing and syntax highlighting interoperable", () => {
    const doc = '{"answer":42,"enabled":true}';
    const tokens: Array<{ text: string; classes: string }> = [];
    highlightTree(jsonLanguage.parser.parse(doc), classHighlighter, (from, to, classes) => {
      tokens.push({ text: doc.slice(from, to), classes });
    });
    expect(tokens.some(token => token.text === "42" && token.classes.includes("number"))).toBe(true);
    expect(tokens.some(token => token.text === "true" && token.classes.includes("bool"))).toBe(true);
  });
});
