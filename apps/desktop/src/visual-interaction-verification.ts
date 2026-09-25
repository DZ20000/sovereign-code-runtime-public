import type { BrowserWindow } from "electron";

export async function verifyWorkbenchInteractions(
  window: BrowserWindow,
  activateView: (window: BrowserWindow, view: string) => Promise<void>,
): Promise<Readonly<Record<string, unknown>>> {
  const checks: Record<string, boolean> = {};
  const details: Record<string, unknown> = {};
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true) as Promise<T>;
  const settle = (): Promise<unknown> => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const waitFor = (expression: string): Promise<boolean> => evaluate(`(async () => {
    const ready = () => (${expression});
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return ready();
  })()`);
  const check = (name: string, passed: boolean, detail?: unknown): void => {
    checks[name] = passed;
    if (detail !== undefined) details[name] = detail;
    if (!passed) throw new Error(`Workbench interaction failed: ${name}`);
  };
  const click = async (selector: string): Promise<void> => {
    const point = await evaluate<{ x: number; y: number }>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Missing interaction control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + Math.min(rect.height / 2, 30);
      if (rect.width <= 0 || rect.height <= 0 || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight ||
        !element.contains(document.elementFromPoint(x, y))) throw new Error('Unreachable interaction control: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
    await settle();
  };
  const language = async (value: string): Promise<void> => {
    await evaluate(`(() => {
      const select = document.querySelector('#ui-language');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
  };
  const field = async (selector: string, value: string): Promise<void> => {
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus();
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
  };
  const editorText = (): Promise<string> => evaluate("Array.from(document.querySelectorAll('#python-code-editor .cm-line'), line => line.textContent).join('\\n')");
  const replacePython = async (source: string): Promise<void> => {
    await click("#python-code-editor .cm-content");
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await window.webContents.debugger.sendCommand("Input.insertText", { text: source });
    await settle();
  };
  const originalLanguage = await evaluate<string>("document.querySelector('#ui-language').value");
  let originalPython: string | null = null;
  let originalTerminal: string | null = null;
  try {
    await language("en");
    await activateView(window, "python");
    check("realCodeMirrorMounted", await waitFor("document.querySelector('#python-code-editor .cm-content[contenteditable=true]') !== null"));
    originalPython = await editorText();
    const pythonSource = 'from pathlib import Path\nprint(Path.cwd())\nprint("Run")';
    await replacePython(pythonSource);
    check("realCodeMirrorAcceptsEditing", await editorText() === pythonSource);
    await language("zh-CN");
    check("codeSurvivesChineseLocalization", await editorText() === pythonSource, await editorText());
    check("editorLabelStillLocalized", await evaluate("document.querySelector('#python-code-editor .cm-content').getAttribute('aria-label') === 'Python 任务编辑器'"));
    const syntaxContrast = await evaluate<{ minimum: number; samples: readonly unknown[] }>(`(() => {
      const parseColor = color => color.match(/[\\d.]+/g).map(Number);
      const luminance = color => {
        const rgb = color.slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const backgroundColor = element => {
        const layers = [];
        for (let node = element; node; node = node.parentElement) {
          const color = parseColor(getComputedStyle(node).backgroundColor);
          layers.push(color);
          if ((color[3] ?? 1) === 1) break;
        }
        return layers.reverse().reduce((background, foreground) => {
          const alpha = foreground[3] ?? 1;
          return background.map((channel, index) => foreground[index] * alpha + channel * (1 - alpha));
        }, [255, 255, 255]);
      };
      const samples = Array.from(document.querySelectorAll('#python-code-editor .cm-line span')).map(span => {
        const foreground = parseColor(getComputedStyle(span).color), background = backgroundColor(span);
        const light = luminance(foreground), dark = luminance(background);
        return { text: span.textContent, color: foreground, background,
          ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
      });
      return { minimum: Math.min(...samples.map(sample => sample.ratio)), samples };
    })()`);
    check("syntaxContrastMeetsNormalTextMinimum", Number.isFinite(syntaxContrast.minimum) && syntaxContrast.minimum >= 4.5, syntaxContrast);
    await language("en");
    const editedSource = `${pythonSource}\nprint(Path("Path"))`;
    await replacePython(editedSource);
    await language("zh-CN");
    check("editedCodeSurvivesLanguageRoundTrip", await editorText() === editedSource, await editorText());
    await click("#python-start-secondary");
    const submitted = await evaluate<string>("window.sovereign.invokeTool('visual.fixture.last-python-code', {})");
    check("submittedCodeMatchesVisibleCode", submitted === editedSource, submitted);

    await evaluate(`(() => {
      const container = document.createElement('div');
      container.id = 'localization-boundary-regression';
      container.hidden = true;
      container.innerHTML = '<div data-no-i18n><span title="Path" aria-label="Run">Path</span></div><pre>Run</pre>';
      document.querySelector('#app').append(container);
    })()`);
    await settle();
    check("rawBodyAndNestedAttributesPreserved", await evaluate(`(() => {
      const raw = document.querySelector('#localization-boundary-regression span');
      return raw.textContent === 'Path' && raw.title === 'Path' && raw.getAttribute('aria-label') === 'Run' &&
        document.querySelector('#localization-boundary-regression pre').textContent === 'Run';
    })()`));
    await language("en");

    await activateView(window, "workflows");
    check("templatesLoaded", await waitFor("document.querySelectorAll('[data-workflow-template-id]').length > 1"));
    await click(".workflow-add-menu > summary");
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle();
    check("addStepEscapeClosesAndRestoresFocus", await evaluate("!document.querySelector('.workflow-add-menu').open && document.activeElement === document.querySelector('.workflow-add-menu > summary')"));
    await click(".workflow-add-menu > summary");
    await click('[data-workflow-add="terminal"]');
    check("addStepClosesMenu", await evaluate("!document.querySelector('.workflow-add-menu').open"));
    const command = '[data-workflow-step-index="2"][data-workflow-step-field="command"]';
    await field(command, "echo keep-my-command");
    await click('[data-workflow-step-index="2"][data-workflow-step-action="remove"]');
    check("deleteKeepsBuilderFocus", await evaluate("document.activeElement?.dataset.workflowStepIndex === '1' && document.activeElement?.dataset.workflowStepAction === 'remove'"));
    await click("#workflow-undo");
    check("deleteUndoRestoresCommand", await evaluate(`document.querySelector(${JSON.stringify(command)})?.value === 'echo keep-my-command'`));
    check("undoIsOneStep", await evaluate("document.querySelector('#workflow-undo').disabled"));
    await field('[data-workflow-step-index="2"][data-workflow-step-field="kind"]', "python");
    check("kindChangeKeepsFocus", await evaluate("document.activeElement?.dataset.workflowStepIndex === '2' && document.activeElement?.dataset.workflowStepField === 'kind'"));
    await click("#workflow-undo");
    check("kindUndoRestoresCommand", await evaluate(`document.querySelector(${JSON.stringify(command)})?.value === 'echo keep-my-command'`));
    await field("#workflow-label", "Keep my workflow");
    await click('[data-workflow-template-id="release-check"]');
    await click("#workflow-undo");
    check("templateUndoRestoresDraft", await evaluate(`document.querySelector('#workflow-label').value === 'Keep my workflow' && document.querySelector(${JSON.stringify(command)})?.value === 'echo keep-my-command'`));
    await click('[data-workflow-step-index="2"][data-workflow-step-action="up"]');
    check("moveKeepsFocusOnMovedStep", await evaluate("document.activeElement?.dataset.workflowStepIndex === '1' && document.activeElement?.dataset.workflowStepAction === 'up' && document.querySelector('[data-workflow-step-index=\"1\"][data-workflow-step-field=\"command\"]')?.value === 'echo keep-my-command'"));
    await click("#workflow-undo");
    await click('[data-workflow-template-id="verify"]');

    await activateView(window, "terminal");
    check("terminalSelectedStateExposed", await waitFor("document.querySelector('[data-terminal-session-id=\"terminal-visual-session\"]') !== null"));
    await click('[data-terminal-session-id="terminal-visual-session"]');
    await settle();
    originalTerminal = await evaluate<string>("document.querySelector('#terminal-output').textContent");
    const terminalSource = Array.from({ length: 200 }, (_value, index) => `output line ${index + 1}`).join("\n");
    await evaluate(`window.sovereign.invokeTool('visual.fixture.terminal-output', { output: ${JSON.stringify(terminalSource)} })`);
    await click("#terminal-refresh");
    check("terminalHasScrollableOutput", await waitFor("document.querySelector('#terminal-output').textContent.includes('output line 200') && document.querySelector('#terminal-output').scrollHeight > document.querySelector('#terminal-output').clientHeight"));
    await evaluate("document.querySelector('#terminal-output').scrollTop = 60");
    await evaluate(`window.sovereign.invokeTool('visual.fixture.terminal-output', { output: ${JSON.stringify(terminalSource + "\nnew output while reading history")} })`);
    await click("#terminal-refresh");
    await waitFor("document.querySelector('#terminal-output').textContent.includes('new output while reading history')");
    const retained = await evaluate<number>("document.querySelector('#terminal-output').scrollTop");
    check("terminalRetainsHistoryPosition", Math.abs(retained - 60) < 2, retained);
    await evaluate("document.querySelector('#terminal-output').scrollTop = document.querySelector('#terminal-output').scrollHeight");
    await evaluate(`window.sovereign.invokeTool('visual.fixture.terminal-output', { output: ${JSON.stringify(terminalSource + "\nnew output while reading history\nlatest followed output")} })`);
    await click("#terminal-refresh");
    await waitFor("document.querySelector('#terminal-output').textContent.includes('latest followed output')");
    check("terminalFollowsWhenAtEnd", await evaluate("(() => { const output = document.querySelector('#terminal-output'); return output.scrollHeight - output.clientHeight - output.scrollTop < 2; })()"));
    check("terminalPressedState", await evaluate("document.querySelector('[data-terminal-session-id=\"terminal-visual-session\"]').getAttribute('aria-pressed') === 'true'"));

    await activateView(window, "browser");
    check("browserSessionPressedState", await waitFor("document.querySelector('#browser-session-list button[aria-pressed=true]') !== null"));
    await click("#browser-observe");
    check("browserElementsObserved", await waitFor("document.querySelector('#browser-element-list button') !== null"));
    await click("#browser-element-list button");
    check("browserElementPressedState", await evaluate("document.querySelector('#browser-element-list button[aria-pressed=true]') !== null"));
    await activateView(window, "computer");
    await click("#computer-empty-state:not([hidden]) #computer-observe-empty, #computer-observe:not([hidden])");
    check("computerWindowsObserved", await waitFor("document.querySelector('#computer-window-list button') !== null"));
    await click("#computer-window-list button");
    check("computerWindowPressedState", await evaluate("document.querySelector('#computer-window-list button[aria-pressed=true]') !== null"));
    check("toolInputsHaveAccessibleNames", await evaluate(`['terminal-input', 'browser-url', 'browser-type-text', 'browser-expression', 'audit-search'].every(id => Boolean(document.getElementById(id)?.getAttribute('aria-label')))`));
  } catch (error) {
    details.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    await evaluate("document.querySelector('#localization-boundary-regression')?.remove()");
    if (originalTerminal !== null) await evaluate(`window.sovereign.invokeTool('visual.fixture.terminal-output', { output: ${JSON.stringify(originalTerminal)} })`);
    if (originalPython !== null) {
      await activateView(window, "python");
      await replacePython(originalPython);
    }
    await language(originalLanguage);
  }
  return { ok: details.error === undefined && Object.values(checks).every(Boolean), checks, details };
}
