import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const CODEMIRROR_CSP_NONCE = "U09WRVJFSUdOLUNPREVNSVJST1I=";
const WORKBENCH_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: "#a5b4fc" },
  { tag: [tags.string, tags.regexp], color: "#a3d4a0" },
  { tag: [tags.number, tags.bool, tags.null], color: "#e8c082" },
  { tag: tags.comment, color: "#a0a8b6", fontStyle: "italic" },
  { tag: [tags.variableName, tags.propertyName], color: "#e6e8ee" },
  { tag: [tags.typeName, tags.className], color: "#93c5fd" },
  { tag: tags.function(tags.variableName), color: "#9ad5df" },
  { tag: [tags.operator, tags.punctuation], color: "#cbd5e1" },
  { tag: tags.invalid, color: "#fca5a5", textDecoration: "underline" },
], { themeType: "dark" });

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
          EditorView.theme({}, { dark: true }),
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
