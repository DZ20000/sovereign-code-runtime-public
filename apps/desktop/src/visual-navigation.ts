import type { BrowserWindow } from "electron";

export const PRIMARY_VISUAL_VIEWS = ["overview", "tasks", "approvals", "settings"] as const;
export const DEVELOPER_VISUAL_VIEWS = ["terminal", "python", "browser", "computer", "workflows"] as const;
export type VisualView = (typeof PRIMARY_VISUAL_VIEWS)[number] | (typeof DEVELOPER_VISUAL_VIEWS)[number];
export type VisualSettingsTab = "appearance" | "security" | "diagnostics";

export async function settleVisualRenderer(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
}

export async function waitForVisualState(window: BrowserWindow, expression: string, description: string): Promise<void> {
  const ready = await window.webContents.executeJavaScript(
    "(async () => { const ready = async () => Boolean(await (" + expression + ")); const deadline = Date.now() + 4000; "
      + "while (!(await ready()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)); return await ready(); })()", true,
  ) as boolean;
  if (!ready) throw new Error("Visual state did not become ready: " + description);
}

export async function clickVisualControl(window: BrowserWindow, selector: string): Promise<void> {
  await window.webContents.executeJavaScript(
    "(() => { const element = document.querySelector(" + JSON.stringify(selector) + "); "
      + "if (!(element instanceof HTMLElement) || !element.checkVisibility() || element.matches(':disabled')) throw new Error('Visual control is unavailable'); "
      + "element.scrollIntoView({block:'nearest',inline:'nearest'}); element.focus({preventScroll:true}); element.click(); })()", true,
  );
  await settleVisualRenderer(window);
}

export async function clickNativeVisualControl(window: BrowserWindow, selector: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || !element.checkVisibility() || element.matches(':disabled')) throw new Error('Native control is unavailable: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({block:'nearest',inline:'nearest'});
    const rect=element.getBoundingClientRect();
    const x=rect.x+rect.width/2, y=rect.y+Math.min(rect.height/2,30);
    if (rect.width<=0 || rect.height<=0 || x<0 || x>=innerWidth || y<0 || y>=innerHeight || !element.contains(document.elementFromPoint(x,y))) throw new Error('Native control is unreachable: ' + ${JSON.stringify(selector)});
    return {x,y};
  })()`, true) as { x: number; y: number };
  await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type:"mousePressed", ...point, button:"left", buttons:1, clickCount:1 });
  await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type:"mouseReleased", ...point, button:"left", buttons:0, clickCount:1 });
  await settleVisualRenderer(window);
}

export async function activateVisualView(window: BrowserWindow, view: string): Promise<void> {
  if (![...PRIMARY_VISUAL_VIEWS, ...DEVELOPER_VISUAL_VIEWS].includes(view as VisualView)) {
    throw new Error("Unknown v2 visual route: " + view);
  }
  const simple = await window.webContents.executeJavaScript("document.documentElement.dataset.experienceMode === 'simple'", true) as boolean;
  if (simple) await clickVisualControl(window, "#v2-mode-expand");
  if ((DEVELOPER_VISUAL_VIEWS as readonly string[]).includes(view)) {
    const expanded = await window.webContents.executeJavaScript("document.querySelector('#execute-group-toggle')?.getAttribute('aria-expanded') === 'true'", true) as boolean;
    if (!expanded) await clickVisualControl(window, "#execute-group-toggle");
  }
  await clickVisualControl(window, '.navigation-item[data-view="' + view + '"]');
  await waitForVisualState(window, "document.querySelector('#view-" + view + ".is-active') !== null", view);
}

export async function activateVisualSettings(window: BrowserWindow, tab: VisualSettingsTab): Promise<void> {
  await activateVisualView(window, "settings");
  await clickVisualControl(window, "#settings-tab-" + tab);
}

export async function openConnectionDrawer(window: BrowserWindow, provider: "chatgpt" | "gemini"): Promise<void> {
  await activateVisualView(window, "overview");
  await clickVisualControl(window, "#v2-" + provider + "-config");
  await waitForVisualState(window,
    "document.querySelector('#connection-drawer')?.checkVisibility() && document.querySelector('#connection-drawer')?.dataset.provider === " + JSON.stringify(provider),
    provider + " drawer",
  );
}

export async function closeConnectionDrawer(window: BrowserWindow): Promise<void> {
  await clickVisualControl(window, "#connection-drawer-close");
  await waitForVisualState(window, "!document.querySelector('#connection-drawer')?.checkVisibility()", "closed connection drawer");
}

export async function openTaskRunHistory(window: BrowserWindow): Promise<void> {
  await activateVisualView(window, "tasks");
  await clickVisualControl(window, "#task-show-all-runs");
  await waitForVisualState(window, "document.querySelector('#runs-workbench-root')?.checkVisibility()", "task run history");
}

export async function selectVisualTaskTab(window: BrowserWindow, tab: "conversation" | "steps" | "output"): Promise<void> {
  await clickVisualControl(window, "#task-tab-" + tab);
  await waitForVisualState(window, "document.querySelector('#task-panel-" + tab + "')?.checkVisibility()", "task " + tab);
}
