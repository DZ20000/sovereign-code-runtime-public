import type { BrowserWindow } from "electron";

const WIDTHS_KEY = "sovereign:task-workbench-widths:v1";
const HUB = '#task-project-grid [data-task-id="task-visual-agent-hub"]';
const RELEASE = '#task-project-grid [data-task-id="task-visual-release"]';

export async function verifyTaskWorkbench(window: BrowserWindow): Promise<Readonly<Record<string, unknown>>> {
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true) as Promise<T>;
  const settle = (): Promise<unknown> => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const waitFor = (expression: string): Promise<boolean> => evaluate(`(async () => {
    const ready = () => (${expression});
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return ready();
  })()`);
  const point = (selector: string): Promise<{ x: number; y: number }> => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Missing workbench control: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + Math.min(rect.height / 2, 80);
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight ||
      !element.contains(document.elementFromPoint(x, y))) throw new Error('Workbench control is not reachable: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`);
  const mouse = (type: string, position: { x: number; y: number }, buttons = 0): Promise<unknown> =>
    window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type, ...position, button: type === "mouseMoved" && buttons === 0 ? "none" : "left", buttons,
      ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
    });
  const click = async (selector: string): Promise<void> => {
    const position = await point(selector);
    await mouse("mouseMoved", position);
    await mouse("mousePressed", position, 1);
    await mouse("mouseReleased", position);
    await settle();
  };
  const key = async (value: "Enter" | "Escape" | "ArrowLeft" | "ArrowRight", modifiers = 0): Promise<void> => {
    const code = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[value];
    const event = { key: value, code: value, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: value === "Enter" ? "keyDown" : "rawKeyDown", ...event,
      ...(value === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    await settle();
  };
  const draft = (value: string): Promise<unknown> => evaluate(`(() => {
    const input = document.querySelector('#task-message-input'); input.focus(); input.value = ${JSON.stringify(value)};
    input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const opened = (): Promise<boolean> => waitFor(`document.querySelector('#task-detail-pane')?.hidden === false &&
    document.querySelector('#task-detail-pane')?.getAttribute('aria-busy') !== 'true' &&
    document.querySelector('#task-detail-layout')?.hidden === false &&
    document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub' &&
    !document.querySelector('#task-message-input')?.disabled`);
  const messageCount = (): Promise<number> => evaluate("window.sovereign.getTaskDetail('task-visual-agent-hub', 20).then(detail => detail.task.messageCount)");
  const reload = (): Promise<void> => new Promise(resolve => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.reload();
  });
  const checks: Record<string, unknown> = {};
  const requireCheck = (name: string, ok: boolean, evidence?: unknown): void => {
    checks[name] = evidence === undefined ? ok : { ok, evidence };
    if (!ok) throw new Error(`Task workbench check failed: ${name}`);
  };
  const originalSize = window.getContentSize();
  const originalWidths = await evaluate<string | null>(`localStorage.getItem(${JSON.stringify(WIDTHS_KEY)})`);
  try {
    window.setContentSize(1360, 860, false);
    requireCheck("wideReady", await waitFor("document.querySelector('.task-hub-shell')?.clientWidth >= 720 && !document.querySelector('.task-hub-shell')?.classList.contains('is-compact')"));
    const lanes: Record<string, readonly string[]> = {
      current: ["task-visual-agent-hub", "task-visual-release"], attention: ["task-visual-sample-clipboard"], history: [],
      activity: ["task-visual-inferred"], all: ["task-visual-agent-hub", "task-visual-release", "task-visual-sample-clipboard", "task-visual-inferred"],
    };
    for (const [lane, expected] of Object.entries(lanes)) {
      await click(`#task-board-lane-${lane === "current" ? "all" : "current"}`);
      await click(HUB);
      requireCheck(`selectedBefore${lane}`, await opened());
      await click(`#task-board-lane-${lane}`);
      const ids = await evaluate<string[]>("Array.from(document.querySelectorAll('#task-project-grid .task-summary-card'), card => card.dataset.taskId).sort()");
      const cleared = await waitFor("document.querySelector('#task-detail-pane')?.hidden && document.querySelector('.task-hub-shell')?.dataset.taskSelected === 'false'");
      requireCheck(`exclusiveLane:${lane}`, JSON.stringify(ids) === JSON.stringify([...expected].sort()) && cleared, { ids, selectedDetailCleared: cleared });
    }
    await click("#task-board-lane-current");
    await click(HUB);
    requireCheck("taskOpened", await opened());
    const geometry = (): Promise<Record<string, number>> => evaluate(`(() => {
      const list = document.querySelector('#task-message-list'), rect = list.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollTop: list.scrollTop };
    })()`);
    const paneGeometry = await evaluate<{ visible: boolean; listWidth: number; gap: number; messageHeight: number; scrollable: boolean; selected: boolean }>(`(() => {
      const list = document.querySelector('#task-hub-list-pane'), detail = document.querySelector('#task-detail-pane');
      const grid = document.querySelector('#task-project-grid'), message = document.querySelector('#task-message-list');
      return { visible: !list.hidden && !detail.hidden, listWidth: list.getBoundingClientRect().width,
        gap: detail.getBoundingClientRect().left - list.getBoundingClientRect().right,
        messageHeight: message.getBoundingClientRect().height, scrollable: ['auto', 'scroll'].includes(getComputedStyle(grid).overflowY),
        selected: document.querySelector(${JSON.stringify(HUB)})?.getAttribute('aria-current') === 'true' };
    })()`);
    requireCheck("parallelPanes", paneGeometry.visible && paneGeometry.listWidth >= 300 && paneGeometry.gap >= -1 &&
      paneGeometry.messageHeight >= 120 && paneGeometry.scrollable && paneGeometry.selected, paneGeometry);
    const beforePopover = await geometry();
    await click("#task-steps-toggle");
    requireCheck("stepsPopover", await waitFor("document.querySelector('#task-steps-popover')?.matches(':popover-open') && document.querySelectorAll('#task-detail-steps .task-step').length === 4"));
    const afterPopover = await geometry();
    requireCheck("stepsDoNotMoveConversation", Object.keys(beforePopover).every(key => Math.abs(beforePopover[key]! - afterPopover[key]!) < 1), { beforePopover, afterPopover });
    requireCheck("stepCount", await evaluate("document.querySelector('#task-detail-step-count')?.textContent?.trim() === '2 / 4'"));
    await key("Escape");
    requireCheck("escapeClosesOnlyPopover", await waitFor("!document.querySelector('#task-steps-popover')?.matches(':popover-open') && document.querySelector('#task-detail-pane')?.hidden === false && document.querySelector('.task-hub-shell')?.dataset.taskSelected === 'true'"));
    await click("#task-steps-toggle");
    requireCheck("stepsReopened", await waitFor("document.querySelector('#task-steps-popover')?.matches(':popover-open')"));
    await click("#task-detail-title");
    requireCheck("outsideClosesPopover", await waitFor("!document.querySelector('#task-steps-popover')?.matches(':popover-open') && document.querySelector('#task-detail-pane')?.hidden === false"));

    await draft("Workbench draft stays with this task.");
    await click(RELEASE);
    requireCheck("directTaskSwitch", await waitFor("document.querySelector('#task-detail-title')?.textContent?.trim() === 'Package and verify the next desktop release'"));
    requireCheck("draftIsolation", await evaluate("document.querySelector('#task-message-input').value !== 'Workbench draft stays with this task.'"));
    await click(HUB);
    requireCheck("draftRestored", await opened() && await evaluate("document.querySelector('#task-message-input').value === 'Workbench draft stays with this task.'"));
    const beforeMessages = await messageCount();
    await draft("First line");
    await key("Enter", 8);
    requireCheck("shiftEnterNewline", await evaluate<boolean>("document.querySelector('#task-message-input').value === 'First line\\n'") && await messageCount() === beforeMessages);
    await draft("中文候选确认");
    const imeEvents = await evaluate<number[]>(`(() => {
      const input = document.querySelector('#task-message-input');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 13, bubbles: true, cancelable: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      const legacy = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
      input.dispatchEvent(legacy); return [legacy.keyCode];
    })()`);
    requireCheck("imeConfirmationDoesNotSend", imeEvents[0] === 229 && await messageCount() === beforeMessages && await evaluate("document.querySelector('#task-message-input').value === '中文候选确认'"));
    let sent = 0;
    for (const [label, modifiers] of [["Enter", 0], ["Ctrl+Enter", 2], ["Command+Enter", 4]] as const) {
      const content = `Workbench ${label} native key submission.`;
      await draft(content);
      await key("Enter", modifiers);
      requireCheck(`send:${label}`, await waitFor(`document.querySelector('#task-message-input').value === '' && !document.querySelector('#task-message-input').disabled &&
        Array.from(document.querySelectorAll('#task-message-list .task-message-user p')).some(row => row.textContent === ${JSON.stringify(content)})`));
      requireCheck(`oneMessage:${label}`, await messageCount() === beforeMessages + ++sent);
    }

    const widths: Record<string, number> = {};
    for (const [name, selector, target] of [
      ["navigation", "#task-navigation-resizer", ".sidebar"], ["tasks", "#task-list-resizer", "#task-hub-list-pane"],
    ] as const) {
      const measure = (): Promise<{ value: number; width: number; valid: boolean }> => evaluate(`(() => {
        const handle = document.querySelector(${JSON.stringify(selector)}), pane = document.querySelector(${JSON.stringify(target)});
        return { value: Number(handle.getAttribute('aria-valuenow')), width: pane.getBoundingClientRect().width,
          valid: handle.getAttribute('role') === 'separator' && handle.getAttribute('aria-orientation') === 'vertical' && handle.tabIndex === 0 };
      })()`);
      const before = await measure(), origin = await point(selector);
      requireCheck(`${name}Separator`, before.valid);
      await evaluate(`(() => {
        const events = [], types = ['pointerdown', 'pointermove', 'pointerup', 'gotpointercapture', 'lostpointercapture'];
        const listener = event => events.push({ type: event.type, target: event.target.id, x: event.clientX, y: event.clientY,
          button: event.button, buttons: event.buttons, primary: event.isPrimary, trusted: event.isTrusted,
          captured: event.target.hasPointerCapture?.(event.pointerId) });
        for (const type of types) document.addEventListener(type, listener, true);
        window.__taskWorkbenchPointerTrace = { events, types, listener };
      })()`);
      await mouse("mouseMoved", origin);
      await mouse("mousePressed", origin, 1);
      await mouse("mouseMoved", { x: origin.x + 32, y: origin.y }, 1);
      await mouse("mouseReleased", { x: origin.x + 32, y: origin.y });
      await settle();
      const dragged = await measure();
      const pointerEvents = await evaluate(`(() => {
        const trace = window.__taskWorkbenchPointerTrace;
        for (const type of trace.types) document.removeEventListener(type, trace.listener, true);
        delete window.__taskWorkbenchPointerTrace; return trace.events;
      })()`);
      requireCheck(`${name}PointerResize`, Math.abs(dragged.value - before.value - 32) <= 1 && Math.abs(dragged.width - before.width - 32) <= 1, { before, dragged, origin, pointerEvents });
      await key("ArrowRight");
      const keyed = await measure();
      requireCheck(`${name}KeyboardResize`, keyed.value === dragged.value + 16 && Math.abs(keyed.width - dragged.width - 16) <= 1, { dragged, keyed });
      widths[name] = keyed.value;
    }
    const persisted = await evaluate<Record<string, number>>(`JSON.parse(localStorage.getItem(${JSON.stringify(WIDTHS_KEY)}))`);
    requireCheck("widthsPersisted", persisted.navigation === widths.navigation && persisted.tasks === widths.tasks, persisted);
    await reload();
    requireCheck("reloaded", await waitFor("document.querySelector('#task-board-lane-current') !== null && document.querySelector('#task-project-select') !== null"));
    await evaluate("document.querySelector('.navigation-item[data-view=tasks]').click()");
    requireCheck("widthsRestoredAfterReload", await waitFor(`Number(document.querySelector('#task-navigation-resizer')?.getAttribute('aria-valuenow')) === ${widths.navigation} && Number(document.querySelector('#task-list-resizer')?.getAttribute('aria-valuenow')) === ${widths.tasks}`));
    await click(HUB);
    requireCheck("restoredTaskOpened", await opened());
    window.setContentSize(800, 680, false);
    requireCheck("compactLayout", await waitFor("document.querySelector('.task-hub-shell')?.classList.contains('is-compact') && getComputedStyle(document.querySelector('#task-hub-list-pane')).display === 'none' && document.querySelector('#task-detail-pane').getBoundingClientRect().width > 0"));
    await click("#task-detail-back");
    requireCheck("compactBackReachable", await waitFor("document.querySelector('#task-detail-pane')?.hidden && getComputedStyle(document.querySelector('#task-hub-list-pane')).display !== 'none' && document.querySelector('.task-hub-shell')?.dataset.taskSelected === 'false'"));
    return { ok: true, inputMethod: "Electron CDP native mouse and keyboard; DOM composition boundary events", checks };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), checks };
  } finally {
    window.setContentSize(originalSize[0]!, originalSize[1]!, false);
    await evaluate(originalWidths === null ? `localStorage.removeItem(${JSON.stringify(WIDTHS_KEY)})` : `localStorage.setItem(${JSON.stringify(WIDTHS_KEY)}, ${JSON.stringify(originalWidths)})`);
    await reload();
    await waitFor("document.querySelector('#task-project-select') !== null");
    await evaluate("document.querySelector('.navigation-item[data-view=tasks]').click(); document.querySelector('#task-detail-back').click(); document.querySelector('#task-board-lane-current').click()");
    await settle();
  }
}
