import type { BrowserWindow } from "electron";

import { assertVisualContext, VISUAL_MATRIX, type VisualContext } from "./visual-matrix.js";
import {
  activateVisualSettings, activateVisualView, clickNativeVisualControl, clickVisualControl, closeConnectionDrawer,
  DEVELOPER_VISUAL_VIEWS, openConnectionDrawer, openTaskRunHistory, PRIMARY_VISUAL_VIEWS,
  selectVisualTaskTab, settleVisualRenderer, waitForVisualState, type VisualView,
} from "./visual-navigation.js";

export interface VisualMatrixCapture {
  readonly context: VisualContext;
  readonly surface: string;
  readonly view: VisualView;
  readonly mode: "full" | "simple";
}

export async function verifyInitialV2Navigation(window: BrowserWindow): Promise<void> {
  const initial = await window.webContents.executeJavaScript(
    "(() => ({ expanded:document.querySelector('#execute-group-toggle')?.getAttribute('aria-expanded'), "
      + "hidden:document.querySelector('#execute-group')?.hidden, "
      + "views:[...document.querySelectorAll('.navigation-item[data-view]')].filter(el => el.checkVisibility()).map(el => el.dataset.view), "
      + "legacy:document.querySelector('#view-agent,#view-runs') !== null }))()", true,
  ) as { expanded: string | null; hidden: boolean; views: string[]; legacy: boolean };
  if (initial.expanded !== "false" || !initial.hidden || initial.legacy
      || JSON.stringify(initial.views) !== JSON.stringify(PRIMARY_VISUAL_VIEWS)) {
    throw new Error("Initial v2 navigation is not the four-entry collapsed layout: " + JSON.stringify(initial));
  }
}

async function closeDeveloperGroup(window: BrowserWindow): Promise<void> {
  const open = await window.webContents.executeJavaScript(
    "document.querySelector('#execute-group-toggle')?.getAttribute('aria-expanded') === 'true'", true,
  ) as boolean;
  if (open) await clickVisualControl(window, "#execute-group-toggle");
}

export async function applyVisualContext(window: BrowserWindow, context: VisualContext): Promise<void> {
  await activateVisualSettings(window, "appearance");
  const preferences = { "#ui-language": context.language, "#pref-theme": context.theme, "#ui-font-scale": "1", "#ui-scale": "1" };
  await window.webContents.executeJavaScript(
    "(() => { for (const [selector,value] of Object.entries(" + JSON.stringify(preferences) + ")) { "
      + "const input=document.querySelector(selector); if (!(input instanceof HTMLSelectElement)) throw new Error('Missing matrix preference'); "
      + "input.value=value; input.dispatchEvent(new Event('change',{bubbles:true})); } })()", true,
  );
  await clickVisualControl(window, "#v2-save-preferences");
  window.webContents.setZoomFactor(1);
  window.setContentSize(context.width, context.height, false);
  await waitForVisualState(window,
    "document.documentElement.lang === " + JSON.stringify(context.language)
      + " && document.documentElement.dataset.theme === " + JSON.stringify(context.theme),
    "matrix locale and theme",
  );
  await settleVisualRenderer(window);
}

async function currentContext(window: BrowserWindow): Promise<{ language: string; theme: string | undefined; width: number; height: number; zoom: number }> {
  const rendered = await window.webContents.executeJavaScript(
    "({language:document.documentElement.lang,theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})", true,
  ) as { language: string; theme: string | undefined; width: number; height: number };
  return { ...rendered, zoom: window.webContents.getZoomFactor() };
}

/** Captures every core surface in each real CSS viewport; behavior probes run separately. */
export async function captureV2VisualMatrix<T>(
  window: BrowserWindow,
  capture: (request: VisualMatrixCapture) => Promise<T>,
  scope: "all" | "tasks" = "all",
): Promise<readonly T[]> {
  const records: T[] = [];
  for (const context of VISUAL_MATRIX) {
    await applyVisualContext(window, context);
    const take = async (surface: string, view: VisualView, mode: "full" | "simple" = "full"): Promise<void> => {
      const dismissConfirmation = await window.webContents.executeJavaScript(
        "document.querySelector('#toast')?.checkVisibility() && document.querySelector('#toast')?.getAttribute('role') === 'status' && !document.querySelector('dialog[open]')", true,
      ) as boolean;
      if (dismissConfirmation) await clickVisualControl(window, "#toast-dismiss");
      await settleVisualRenderer(window);
      assertVisualContext(context, await currentContext(window));
      records.push(await capture({ context, surface, view, mode }));
    };

    if (scope === "all") {
    await activateVisualView(window, "overview");
    await closeDeveloperGroup(window);
    await verifyInitialV2Navigation(window);
    await take("home-full", "overview");
    for (const provider of ["chatgpt", "gemini"] as const) {
      await openConnectionDrawer(window, provider);
      await take("connection-" + provider, "overview");
      if (provider === "gemini") {
        for (const [open, close, name] of [["protected-open", "protected-cancel", "protected"], ["import", "import-cancel", "import"], ["presets", "preset-cancel", "presets"]] as const) {
          await clickVisualControl(window, "#gemini-" + open);
          if (name === "import") {
            await window.webContents.executeJavaScript("(async()=>{const status=await window.sovereign.getGeminiConnection();const input=document.querySelector('#gemini-import-json');input.value=JSON.stringify(status.configuration??{publicMcpUrl:'https://mcp.example.test/mcp',oauthDiscoveryUrl:'https://oauth.example.test/discovery',introspectionUrl:'https://oauth.example.test/introspect',clientId:'matrix-preview',loopbackPort:0});input.dispatchEvent(new Event('input',{bubbles:true}));})()", true);
            await clickVisualControl(window,"#gemini-import-preview");
            await waitForVisualState(window,"!document.querySelector('#gemini-import-fields').hidden","public import preview");
          }
          await take("connection-gemini-" + name, "overview");
          await clickVisualControl(window, "#gemini-" + close);
        }
      }
      await closeConnectionDrawer(window);
    }

    await clickVisualControl(window, "#v2-mode-simple");
    await waitForVisualState(window, "document.documentElement.dataset.experienceMode === 'simple'", "simple companion mode");
    const simple = await window.webContents.executeJavaScript(
      "(() => { const content=document.querySelector('.content-scroll'); return { "
        + "sidebar:document.querySelector('.sidebar')?.checkVisibility(), "
        + "developer:document.querySelector('#execute-group-toggle')?.checkVisibility(), "
        + "navigation:[...document.querySelectorAll('.navigation-item')].filter(el=>el.checkVisibility()).length, "
        + "onePage:content instanceof HTMLElement && content.scrollHeight <= content.clientHeight + 1, "
        + "chatgpt:document.querySelector('#v2-chatgpt-config')?.checkVisibility(), "
        + "gemini:document.querySelector('#v2-gemini-config')?.checkVisibility() }; })()", true,
    ) as Record<string, unknown>;
    if (simple.sidebar || simple.developer || simple.navigation !== 0 || !simple.onePage || !simple.chatgpt || !simple.gemini) {
      throw new Error("Simple mode is not a single-page companion: " + JSON.stringify(simple));
    }
    await take("home-simple", "overview", "simple");
    await clickVisualControl(window, "#v2-mode-expand");
    await waitForVisualState(window, "document.documentElement.dataset.experienceMode === 'full'", "full mode restored");
    }

    await activateVisualView(window, "tasks");
    await window.webContents.executeJavaScript(
      "(() => { const project=document.querySelector('#task-project-select'); project.value=''; "
        + "project.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#task-board-lane-current').click(); })()", true,
    );
    const selectedTask = '#task-project-grid [data-task-id="task-visual-agent-hub"]';
    await waitForVisualState(window, "document.querySelector(" + JSON.stringify(selectedTask) + ")?.checkVisibility()", "matrix task row");
    await clickVisualControl(window, selectedTask);
    await waitForVisualState(window,
      "document.querySelector('#task-detail-pane')?.getAttribute('aria-busy') !== 'true' && document.querySelector('#task-detail-layout')?.hidden === false",
      "selected matrix task",
    );
    for (const tab of ["conversation", "steps", "output"] as const) {
      await selectVisualTaskTab(window, tab);
      await take("tasks-" + tab, "tasks");
    }
    await openTaskRunHistory(window);
    await take("tasks-history", "tasks");
    await clickVisualControl(window, "#task-history-back");

    if (scope === "tasks") continue;
    await activateVisualView(window, "approvals");
    await clickVisualControl(window, "#v2-approvals-tab-pending");
    await take("approvals-pending", "approvals");
    await clickVisualControl(window, "#v2-approvals-tab-audit");
    await waitForVisualState(window, "document.querySelector('#v2-audit-list [data-receipt-id]')?.checkVisibility()", "matrix audit receipt");
    await clickVisualControl(window, "#v2-audit-list [data-receipt-id]");
    await take("approvals-audit", "approvals");
    await clickVisualControl(window, "#v2-audit-close");
    for (const tab of ["appearance", "security", "diagnostics"] as const) {
      await activateVisualSettings(window, tab);
      await take("settings-" + tab, "settings");
    }
    for (const view of DEVELOPER_VISUAL_VIEWS) {
      await activateVisualView(window, view);
      if (view === "computer") {
        await waitForVisualState(window, "(() => { const button=document.querySelector('#computer-empty-state:not([hidden]) #computer-observe-empty, #computer-observe:not([hidden])'); return button?.checkVisibility() && !button.disabled; })()", "fixture desktop capture available");
        await clickNativeVisualControl(window, "#computer-empty-state:not([hidden]) #computer-observe-empty, #computer-observe:not([hidden])");
        try {
          await waitForVisualState(window, "document.querySelector('#computer-workspace').checkVisibility() && document.querySelector('#computer-window-list button') !== null && document.querySelector('#computer-preview').complete && document.querySelector('#computer-preview').naturalWidth > 0", "captured fixture desktop");
        } catch {
          const state = await window.webContents.executeJavaScript("(async()=>({calls:await window.sovereign.invokeTool('visual.fixture.computer-observe-count',{}),revision:document.querySelector('#computer-revision')?.textContent,windows:document.querySelectorAll('#computer-window-list button').length,image:{complete:document.querySelector('#computer-preview').complete,width:document.querySelector('#computer-preview').naturalWidth},feedback:document.querySelector('#toast').textContent}))()",true);
          throw new Error("Fixture desktop capture did not complete: " + JSON.stringify(state));
        }
      }
      await take("developer-" + view, view);
    }
    await closeDeveloperGroup(window);
  }
  return records;
}
