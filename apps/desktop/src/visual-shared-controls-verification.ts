import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

import {
  activateVisualSettings, activateVisualView, clickVisualControl, DEVELOPER_VISUAL_VIEWS,
  PRIMARY_VISUAL_VIEWS, settleVisualRenderer, waitForVisualState,
} from "./visual-navigation.js";

export async function verifySharedControls(
  window: BrowserWindow,
  _activateView: (window: BrowserWindow, view: string) => Promise<void>,
  outputRoot: string,
): Promise<Readonly<Record<string, unknown>>> {
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true) as Promise<T>;
  const failures: string[] = [];
  const pages: unknown[] = [];
  const originalSize = window.getContentSize();
  const originalZoom = window.webContents.getZoomFactor();
  const originalPreferences = await evaluate<string | null>("localStorage.getItem('sovereign.ui.settings.v1')");
  const preference = async (selector: string, value: string | boolean): Promise<void> => {
    await activateVisualSettings(window, "appearance");
    await evaluate("(() => { const input=document.querySelector(" + JSON.stringify(selector) + "); "
      + "if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLSelectElement)) throw new Error('Missing preference'); "
      + "input[input.type==='checkbox'?'checked':'value']=" + JSON.stringify(value) + "; input.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await clickVisualControl(window, "#v2-save-preferences");
    await settleVisualRenderer(window);
  };
  const capture = async (name: string): Promise<void> => {
    await settleVisualRenderer(window);
    await writeFile(join(outputRoot, "controls-" + name + ".png"), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  };
  try {
    await activateVisualSettings(window,"appearance");
    const beforePreview=await evaluate<string | null>("localStorage.getItem('sovereign.ui.settings.v1')");
    await evaluate("(() => {const theme=document.querySelector('#pref-theme');theme.value='dark';theme.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await settleVisualRenderer(window);
    if (await evaluate("document.documentElement.dataset.theme") !== "dark" || await evaluate("localStorage.getItem('sovereign.ui.settings.v1')") !== beforePreview) failures.push("Theme preview persisted before Save");
    await clickVisualControl(window,"#v2-save-preferences");
    if (!(await evaluate<boolean>("JSON.parse(localStorage.getItem('sovereign.ui.settings.v1')).theme==='dark'"))) failures.push("Theme Save did not persist");
    await evaluate("(() => {const mode=document.querySelector('#ui-experience-mode');mode.value='simple';mode.dispatchEvent(new Event('change',{bubbles:true}));})()");
    if (!(await evaluate<boolean>("document.documentElement.dataset.experienceMode==='full'&&JSON.parse(localStorage.getItem('sovereign.ui.settings.v1')).experienceMode==='full'"))) failures.push("Mode draft changed navigation before Save");
    await clickVisualControl(window,"#v2-save-preferences");
    await waitForVisualState(window,"document.documentElement.dataset.experienceMode==='simple'","saved Simple preference");
    await clickVisualControl(window,"#v2-mode-expand");
    await activateVisualSettings(window,"appearance");
    const beforeReset=await evaluate("localStorage.getItem('sovereign.ui.settings.v1')");
    await evaluate("document.querySelector('#reset-interface-settings').click()");
    if (await evaluate("localStorage.getItem('sovereign.ui.settings.v1')") !== beforeReset) failures.push("Reset wrote preferences before Save");
    await preference("#ui-language", "zh-CN");
    await preference("#ui-font-scale", "1.3");
    for (const zoom of [1, 1.5]) {
      window.setContentSize(1040, 680, false);
      window.webContents.setZoomFactor(zoom);
      for (const view of [...PRIMARY_VISUAL_VIEWS, ...DEVELOPER_VISUAL_VIEWS]) {
        await activateVisualView(window, view);
        const panes = view === "settings" ? ["appearance", "security", "diagnostics"] as const : [""];
        for (const pane of panes) {
          if (pane) await clickVisualControl(window, "#settings-tab-" + pane);
          const result = await evaluate<{ failures: string[] }>(
            "(() => { const root=document.querySelector('.view.is-active'); const failures=[]; "
            + "const visible=el=>el.checkVisibility({visibilityProperty:true}) && el.getBoundingClientRect().width>2; "
            + "const controls=[...root.querySelectorAll('button,select,input:not([type=hidden]),textarea,summary')].filter(visible); "
            + "const clippedByScroll=el=>{for(let p=el.parentElement;p&&p!==root;p=p.parentElement){if(['auto','scroll'].includes(getComputedStyle(p).overflowX)&&p.scrollWidth>p.clientWidth+1)return true;}return false;}; "
            + "for(const el of controls){const r=el.getBoundingClientRect(),s=getComputedStyle(el); const name=el.id||el.getAttribute('aria-label')||el.textContent.trim().slice(0,30); "
            + "if((r.right>innerWidth+2||r.left< -2)&&!clippedByScroll(el))failures.push(name+': horizontal overflow'); "
            + "if(el.matches('select,input,textarea')&&parseFloat(s.fontSize)<11)failures.push(name+': unreadably small');} "
            + "for(const el of root.querySelectorAll('[hidden]'))if(el.getAttribute('hidden')!=='until-found'&&getComputedStyle(el).display!=='none')failures.push((el.id||el.className)+': hidden content displayed'); "
            + "for(const el of root.querySelectorAll('.visually-hidden,.sr-only'))if(el.getBoundingClientRect().width>1||el.getBoundingClientRect().height>1)failures.push((el.id||el.className)+': assistive text leaked'); "
            + "for(const el of root.querySelectorAll('.number-with-unit')){if(!visible(el))continue;const r=el.getBoundingClientRect();for(let parent=el.parentElement;parent;parent=parent.parentElement){const b=parent.getBoundingClientRect();if(getComputedStyle(parent).overflowX==='hidden'&&(r.right>b.right+1||r.left<b.left-1))failures.push('Number and unit clipped');}} "
            + "const primary=root.querySelector('#python-start-secondary');if(primary&&visible(primary)){const r=primary.getBoundingClientRect();if(r.bottom>innerHeight||r.top<0)failures.push('Python Run is outside the first screen');} "
            + "const tabs=[...root.querySelectorAll('.settings-tab')].filter(visible);for(let i=1;i<tabs.length;i++){const a=tabs[i-1].getBoundingClientRect(),b=tabs[i].getBoundingClientRect();if(a.right>b.left+1&&Math.abs(a.top-b.top)<2)failures.push('Settings tabs overlap');} "
            + "return {view:root.id,viewport:[innerWidth,innerHeight],controls:controls.length,failures};})()",
          );
          pages.push({ zoom, pane, ...result });
          failures.push(...result.failures.map((issue) => zoom + "/" + view + "/" + pane + ": " + issue));
          await capture("stress-" + zoom + "-" + view + (pane ? "-" + pane : ""));
        }
      }
      await activateVisualView(window, "overview");
      await clickVisualControl(window, "#v2-mode-simple");
      const simple = await evaluate<{ overflow: boolean; sidebar: boolean }>(
        "({overflow:document.documentElement.scrollWidth>innerWidth,sidebar:document.querySelector('.sidebar').checkVisibility()})",
      );
      if (simple.overflow || simple.sidebar) failures.push("Scaled Simple mode exposes the sidebar or horizontal overflow");
      await capture("stress-" + zoom + "-simple");
      await clickVisualControl(window, "#v2-mode-expand");
    }

    window.setContentSize(1360, 860, false);
    window.webContents.setZoomFactor(1);
    await preference("#ui-font-scale", "1");
    await activateVisualSettings(window, "security");
    const keyboard = await evaluate<boolean>(
      "(async()=>{const security=document.querySelector('#settings-tab-security');security.focus();security.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));"
      + "await new Promise(resolve=>requestAnimationFrame(resolve));const left=document.activeElement?.id==='settings-tab-appearance'&&document.querySelector('#settings-tab-appearance').getAttribute('aria-selected')==='true';"
      + "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));"
      + "return left&&document.activeElement?.id==='settings-tab-security'&&security.getAttribute('aria-selected')==='true'&&security.tabIndex===0&&document.querySelectorAll('[data-settings-tab]').length===3;})()",
    );
    if (!keyboard) failures.push("The three settings tabs lost keyboard selection");
    await preference("#sidebar-collapsed-setting", true);
    const collapsed = await evaluate<boolean>(
      "(() => {const sidebar=document.querySelector('.sidebar');return sidebar.getBoundingClientRect().width<=100&&[...document.querySelectorAll('.navigation-label')].every(el=>!el.checkVisibility())&&document.querySelector('.navigation-item .v2-icon').checkVisibility();})()",
    );
    if (!collapsed) failures.push("Collapsed navigation does not retain icons while hiding labels");
    await capture("collapsed-sidebar");
    await preference("#sidebar-collapsed-setting", false);

    await activateVisualSettings(window, "appearance");
    await evaluate("document.querySelector('#ui-startup-view').focus(); document.querySelector('#ui-startup-view').showPicker()");
    await settleVisualRenderer(window);
    const picker = await evaluate<{ open: boolean; appearance: string; focused: boolean; native: boolean }>("(() => {const input=document.querySelector('#ui-startup-view');return {open:input.matches(':open'),appearance:getComputedStyle(input).appearance,focused:document.activeElement===input,native:input instanceof HTMLSelectElement&&!input.disabled};})()");
    // Native OS popups are not painted into an offscreen BrowserWindow. Only
    // customizable in-renderer pickers expose :open; both must accept the real
    // keyboard choice below and persist it only after Save.
    if (!picker.native || !picker.focused || (picker.appearance === "base-select" && !picker.open)) failures.push("The startup-page select is not operable");
    await capture("dropdown-open");
    for (const [key, code] of [["End", 35], ["Enter", 13]] as const) {
      await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code });
      await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    }
    await clickVisualControl(window, "#v2-save-preferences");
    if (await evaluate("document.querySelector('#ui-startup-view').value") !== "last") failures.push("The native picker did not commit its keyboard selection");
    const persisted = await evaluate<Record<string, unknown>>("JSON.parse(localStorage.getItem('sovereign.ui.settings.v1'))");
    if (persisted.startupView !== "last" || persisted.language !== "zh-CN") failures.push("Saved interface preferences were not persisted");

    await preference("#ui-reduced-motion", true);
    const reduced = await evaluate<number>("parseFloat(getComputedStyle(document.querySelector('#ui-startup-view')).transitionDuration)");
    if (reduced > 0.001) failures.push("Reduce motion does not suppress transitions");

    await preference("#pref-theme", "system");
    for (const theme of ["dark", "light"]) {
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: theme }] });
      await waitForVisualState(window, "document.documentElement.dataset.theme===" + JSON.stringify(theme), "system theme follows the OS preference");
    }
    return { ok: failures.length === 0, failures, pages, picker, reducedMotionSeconds: reduced };
  } finally {
    await evaluate(originalPreferences === null
      ? "localStorage.removeItem('sovereign.ui.settings.v1')"
      : "localStorage.setItem('sovereign.ui.settings.v1'," + JSON.stringify(originalPreferences) + ")");
    const loaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    window.webContents.reload();
    await loaded;
    await waitForVisualState(window, "document.querySelector('.application-shell') && document.querySelector('#v2-chatgpt-config')", "preferences restored");
    window.webContents.setZoomFactor(originalZoom);
    window.setContentSize(originalSize[0]!, originalSize[1]!, false);
  }
}
