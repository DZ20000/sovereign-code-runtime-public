import type { BrowserWindow } from "electron";
import { clickNativeVisualControl } from "./visual-navigation.js";

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
  const click = (selector: string): Promise<void> => clickNativeVisualControl(window, selector);
  const language = async (value: string): Promise<void> => {
    await evaluate(`(() => {
      const select = document.querySelector('#ui-language');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
  };
  const field = async (selector: string, value: string): Promise<void> => {
    for (let attempt=0; attempt<3; attempt+=1) {
      const closed = await evaluate<boolean>("Boolean(document.querySelector(" + JSON.stringify(selector) + ")?.closest('details:not([open])'))");
      if (!closed) break;
      await click("details:not([open]):has(" + selector + ") > summary");
    }
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLElement) || !input.checkVisibility()) throw new Error('Field is not visible: ' + ${JSON.stringify(selector)});
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
      const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
      const context = canvas.getContext('2d', {willReadFrequently:true});
      const parseColor = color => {
        context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1);
        const rgba=context.getImageData(0,0,1,1).data;
        return [rgba[0],rgba[1],rgba[2],rgba[3]/255];
      };
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
    checks.syntaxContrastMeetsNormalTextMinimum = Number.isFinite(syntaxContrast.minimum) && syntaxContrast.minimum >= 4.5;
    details.syntaxContrastMeetsNormalTextMinimum = syntaxContrast;
    await language("en");
    const editedSource = `${pythonSource}\nprint(Path("Path"))`;
    await replacePython(editedSource);
    await language("zh-CN");
    check("editedCodeSurvivesLanguageRoundTrip", await editorText() === editedSource, await editorText());
    await click("#python-start-secondary");
    const submitted = await evaluate<string>("window.sovereign.invokeTool('visual.fixture.last-python-code', {})");
    check("submittedCodeMatchesVisibleCode", submitted === editedSource, submitted);
    const pythonStartsBeforeTabs = await evaluate<number>("window.sovereign.invokeTool('visual.fixture.python-start-count', {})");
    await click("#python-output-tab-stderr");
    check("pythonOutputTabsPreserveDraft", await evaluate<boolean>("document.querySelector('#python-output-tab-stderr').getAttribute('aria-selected') === 'true' && document.querySelector('#python-live-stderr').checkVisibility() && !document.querySelector('#python-live-stdout').checkVisibility()") && await editorText() === editedSource);
    await click("#python-refresh");
    check("pythonRefreshPreservesOutputTab", await waitFor("!document.querySelector('#python-refresh').disabled && document.querySelector('#python-output-tab-stderr').getAttribute('aria-selected') === 'true' && document.querySelector('#python-live-stderr').checkVisibility()") && await editorText() === editedSource);
    await click("#python-output-tab-stderr");
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type:"keyDown", key:"ArrowLeft", code:"ArrowLeft", windowsVirtualKeyCode:37 });
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type:"keyUp", key:"ArrowLeft", code:"ArrowLeft", windowsVirtualKeyCode:37 });
    await settle();
    check("pythonOutputKeyboardNavigation", await evaluate("document.activeElement === document.querySelector('#python-output-tab-stdout') && document.querySelector('#python-output-tab-stdout').getAttribute('aria-selected') === 'true' && document.querySelector('#python-live-stdout').checkVisibility() && !document.querySelector('#python-live-stderr').checkVisibility()"));
    check("pythonOutputTabsNeverReplayRun", await evaluate<number>("window.sovereign.invokeTool('visual.fixture.python-start-count', {})") === pythonStartsBeforeTabs);

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
    const terminalFixture = await evaluate<{ output: string }>("window.sovereign.invokeTool('terminal.session.read', { sessionId: 'terminal-visual-session' })");
    await click('[data-terminal-session-id="terminal-visual-session"]');
    // A native click plus two animation frames does not await the controller's IPC read.
    check("terminalSelectionAndInitialOutputReady", await waitFor(
      "document.querySelector('[data-terminal-session-id=\"terminal-visual-session\"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#terminal-output').textContent === " + JSON.stringify(terminalFixture.output),
    ));
    originalTerminal = terminalFixture.output;
    const terminalSource = Array.from({ length: 200 }, (_value, index) => `output line ${index + 1}`).join("\n");
    await evaluate(`window.sovereign.invokeTool('visual.fixture.terminal-output', { output: ${JSON.stringify(terminalSource)} })`);
    await click("#terminal-refresh");
    const terminalScrollable = await waitFor("document.querySelector('#terminal-output').textContent.includes('output line 200') && document.querySelector('#terminal-output').scrollHeight > document.querySelector('#terminal-output').clientHeight");
    const terminalOutputEvidence = await evaluate(`(() => {
      const output = document.querySelector('#terminal-output');
      return { selected: document.querySelector('#terminal-session-list [aria-pressed=true]')?.dataset.terminalSessionId,
        title: document.querySelector('#terminal-title').textContent,
        outputTail: output.textContent.slice(-240), outputCharacters: output.textContent.length,
        scrollHeight: output.scrollHeight, clientHeight: output.clientHeight,
        scrollTop: output.scrollTop, visible: output.checkVisibility(),
        overflowY: getComputedStyle(output).overflowY, activeView: document.querySelector('.app-view.is-active')?.id };
    })()`);
    check("terminalHasScrollableOutput", terminalScrollable, terminalOutputEvidence);
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
    const browserSnapshot = () => evaluate<string>(`JSON.stringify({
      revision:document.querySelector('#browser-revision').textContent,
      text:document.querySelector('#browser-text').textContent,
      screenshot:document.querySelector('#browser-preview').getAttribute('src'),
      session:document.querySelector('#browser-session-list [aria-pressed=true]')?.dataset.browserSessionId,
      element:document.querySelector('#browser-element-list [aria-pressed=true]')?.textContent
    })`);
    const beforeBrowserTabs = await browserSnapshot();
    const browserOperationsBefore = await evaluate<number>("window.sovereign.invokeTool('visual.fixture.browser-operation-count', {})");
    await click("#browser-screenshot-tab");
    check("browserScreenshotTab", await evaluate("document.querySelector('#browser-screenshot-tab').getAttribute('aria-selected') === 'true' && document.querySelector('#browser-screenshot-panel').checkVisibility() && !document.querySelector('#browser-text-panel').checkVisibility()"));
    check("browserFixturePreviewDecoded", await waitFor("document.querySelector('#browser-preview').complete && document.querySelector('#browser-preview').naturalWidth > 0"));
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type:"keyDown", key:"ArrowLeft", code:"ArrowLeft", windowsVirtualKeyCode:37 });
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type:"keyUp", key:"ArrowLeft", code:"ArrowLeft", windowsVirtualKeyCode:37 });
    await settle();
    check("browserTabKeyboardNavigation", await evaluate("document.activeElement === document.querySelector('#browser-text-tab') && document.querySelector('#browser-text-tab').getAttribute('aria-selected') === 'true' && document.querySelector('#browser-text-panel').checkVisibility() && !document.querySelector('#browser-screenshot-panel').checkVisibility()"));
    check("browserTabsPreserveObservation", await browserSnapshot() === beforeBrowserTabs &&
      await evaluate<number>("window.sovereign.invokeTool('visual.fixture.browser-operation-count', {})") === browserOperationsBefore);
    await activateView(window, "computer");
    check("computerCaptureReady", await waitFor("(() => { const button=document.querySelector('#computer-empty-state:not([hidden]) #computer-observe-empty, #computer-observe:not([hidden])'); return button?.checkVisibility() && !button.disabled; })()"));
    const computerObserveCountBefore = await evaluate<number>("window.sovereign.invokeTool('visual.fixture.computer-observe-count', {})");
    await evaluate(`(() => {
      const probe = { events: [], handler: null };
      probe.handler = event => {
        const target = event.target instanceof Element ? event.target : null;
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        probe.events.push({ type: event.type, trusted: event.isTrusted, target: target?.id || target?.tagName,
          button: target?.closest('button')?.id, x: event.clientX, y: event.clientY,
          hit: hit?.id || hit?.tagName, disabled: target?.closest('button')?.disabled });
        if (probe.events.length > 12) probe.events.shift();
      };
      window.__visualComputerPointerProbe = probe;
      for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, probe.handler, true);
    })()`);
    await click("#computer-empty-state:not([hidden]) #computer-observe-empty, #computer-observe:not([hidden])");
    const computerWindowsObserved = await waitFor("document.querySelector('#computer-window-list button') !== null");
    const computerObservationEvidence = await evaluate(`(() => {
      const probe = window.__visualComputerPointerProbe;
      for (const type of ['mousedown', 'mouseup', 'click']) document.removeEventListener(type, probe.handler, true);
      delete window.__visualComputerPointerProbe;
      const buttons = ['computer-observe-empty', 'computer-observe'].map(id => {
        const button = document.getElementById(id), rect = button.getBoundingClientRect();
        return { id, visible: button.checkVisibility(), disabled: button.disabled,
          text: button.textContent, rect: {x:rect.x,y:rect.y,width:rect.width,height:rect.height} };
      });
      return { events: probe.events, buttons, windowCount: document.querySelectorAll('#computer-window-list button').length,
        capability: document.querySelector('#computer-capability').textContent,
        workspaceVisible: document.querySelector('#computer-workspace').checkVisibility(),
        emptyVisible: document.querySelector('#computer-empty-state').checkVisibility() };
    })()`);
    const computerObserveCountAfter = await evaluate<number>("window.sovereign.invokeTool('visual.fixture.computer-observe-count', {})");
    check("computerCaptureDispatchedOnce", computerObserveCountAfter === computerObserveCountBefore + 1,
      { before: computerObserveCountBefore, after: computerObserveCountAfter, state: computerObservationEvidence });
    check("computerWindowsObserved", computerWindowsObserved,
      { before: computerObserveCountBefore, after: computerObserveCountAfter, state: computerObservationEvidence });
    check("computerFixturePreviewDecoded", await waitFor("document.querySelector('#computer-preview').complete && document.querySelector('#computer-preview').naturalWidth > 0"));
    await click("#computer-window-list button");
    check("computerWindowPressedState", await evaluate("document.querySelector('#computer-window-list button[aria-pressed=true]') !== null"));
    check("toolInputsHaveAccessibleNames", await evaluate(`['terminal-input', 'browser-url', 'browser-type-text', 'browser-expression', 'v2-audit-search'].every(id => {
      const control=document.getElementById(id);
      return !!control?.getAttribute('aria-label')?.trim() || [...(control?.labels??[])].some(label=>!!label.querySelector('span')?.textContent.trim());
    })`));
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
