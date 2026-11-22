import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const CODEMIRROR_CSP_NONCE = "U09WRVJFSUdOLUNPREVNSVJST1I=";
// The design uses neutral code text; comments and invalid spans retain distinct cues.
const WORKBENCH_HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.string, tags.regexp, tags.number, tags.bool, tags.null,
      tags.variableName, tags.propertyName, tags.typeName, tags.className,
      tags.function(tags.variableName), tags.operator, tags.punctuation], color: "var(--color-text)" },
  { tag: tags.comment, color: "var(--color-secondary)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--color-text)", textDecoration: "underline", textDecorationColor: "var(--color-danger)" },
]);

export type WorkbenchCodeLanguage = "python" | "json";

export interface WorkbenchCodeEditorOptions {
  readonly parent: HTMLElement;
  readonly value: string;
  readonly language: WorkbenchCodeLanguage;
  readonly ariaLabel: string;
  readonly onChange?: (value: string) => void;
}

function languageExtension(language: WorkbenchCodeLanguage): Extension {
  return language === "python" ? python() : json();
}

export class WorkbenchCodeEditor {
  readonly #view: EditorView;

  constructor(options: WorkbenchCodeEditorOptions) {
    this.#view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.value,
        extensions: [
          basicSetup,
          languageExtension(options.language),
          EditorView.theme({}),
          syntaxHighlighting(WORKBENCH_HIGHLIGHT),
          EditorState.tabSize.of(2),
          EditorView.cspNonce.of(CODEMIRROR_CSP_NONCE),
          EditorView.contentAttributes.of({
            "aria-label": options.ariaLabel,
            spellcheck: "false",
          }),
          keymap.of([indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              options.onChange?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
  }

  getValue(): string {
    return this.#view.state.doc.toString();
  }

  setValue(value: string): void {
    const current = this.getValue();
    if (current === value) {
      return;
    }
    this.#view.dispatch({
      changes: {
        from: 0,
        to: this.#view.state.doc.length,
        insert: value,
      },
    });
  }

  requestMeasure(): void {
    this.#view.requestMeasure();
  }

  destroy(): void {
    this.#view.destroy();
  }
}
