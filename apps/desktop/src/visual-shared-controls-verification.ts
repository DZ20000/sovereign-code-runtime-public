import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

export async function verifySharedControls(
  window: BrowserWindow,
  activateView: (window: BrowserWindow, view: string) => Promise<void>,
  outputRoot: string,
): Promise<Readonly<Record<string, unknown>>> {
  const failures: string[] = [];
  const pages: unknown[] = [];
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true) as Promise<T>;
  const settle = (): Promise<void> => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const originalSize = window.getContentBounds();
  const originalZoom = window.webContents.getZoomFactor();
  const originalPreferences = await evaluate<{ language: string; font: string; startup: string; reduced: boolean; mode:string }>(`({
    language: document.querySelector('#ui-language').value, font: document.querySelector('#ui-font-scale').value,
    startup: document.querySelector('#ui-startup-view').value, reduced: document.querySelector('#ui-reduced-motion').checked,
    mode: document.querySelector('#ui-experience-mode').value
  })`);
  const preference = async (selector: string, value: string | boolean): Promise<void> => {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      el[el.type === 'checkbox' ? 'checked' : 'value'] = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await settle();
  };
  const capture = async (name: string): Promise<void> => {
    await settle();
    await writeFile(join(outputRoot, `controls-${name}.png`), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  };
  try {
    await preference('#ui-language', 'zh-CN');
    for (const mode of ['full', 'simple']) {
      await preference('#ui-experience-mode', mode);
      const views = await evaluate<string[]>("[...document.querySelectorAll('.navigation-item[data-view]')].filter(el => el.checkVisibility()).map(el => el.dataset.view)");
      for (const [width, height, zoom, font] of [[1360, 860, 1.1, '1'], [1040, 720, 1.1, '1.3'], [1040, 720, 1.5, '1.3']] as const) {
      window.setContentSize(width, height, false);
      window.webContents.setZoomFactor(zoom);
      await preference('#ui-font-scale', font);
      for (const view of views) {
        await activateView(window, view);
        const panes = view === 'settings' ? (mode === 'full' ? ['appearance', 'host', 'security', 'diagnostics'] : ['appearance', 'host', 'security']) : [''];
        for (const pane of panes) {
          if (pane) await evaluate(`document.querySelector('[data-settings-tab="${pane}"]').click()`);
          await settle();
          const result = await evaluate<{ failures: string[] }>(`(() => {
            const root = document.querySelector('#view-${view}');
            const failures = [];
            const visible = el => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 2;
            const controls = [...root.querySelectorAll('button,select,input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea,summary')].filter(visible);
            const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
            for (const label of document.querySelectorAll('.navigation-label')) {
              if (visible(label) && (sidebar.width < 100 || label.getBoundingClientRect().right > sidebar.right + 1)) failures.push('Navigation label is clipped');
            }
            for (const el of controls) {
              const r = el.getBoundingClientRect(), s = getComputedStyle(el);
              const name = el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30);
              if (r.right > innerWidth + 2 || r.left < -2) failures.push(name + ': outside horizontal viewport');
              if (el.matches('select,.text-field') && parseFloat(s.fontSize) < 12) failures.push(name + ': unreadably small');
            }
            for (const el of root.querySelectorAll('[hidden]')) {
              if (el.getAttribute('hidden') !== 'until-found' && getComputedStyle(el).display !== 'none') failures.push((el.id || el.className) + ': hidden content is displayed');
            }
            for (const el of root.querySelectorAll('.visually-hidden,#web-profile-badge')) {
              if (el.getBoundingClientRect().width > 1 || el.getBoundingClientRect().height > 1) failures.push((el.id || el.className) + ': assistive text leaks into layout');
            }
            for (const el of root.querySelectorAll('.permission-profile-option')) {
              if (visible(el) && getComputedStyle(el).display !== 'grid') failures.push('Permission card lost its shared layout');
            }
            for (const el of root.querySelectorAll('.number-with-unit')) {
              if (!visible(el)) continue;
              const rect = el.getBoundingClientRect();
              for (let parent = el.parentElement; parent; parent = parent.parentElement) {
                const bounds = parent.getBoundingClientRect();
                if (getComputedStyle(parent).overflowX === 'hidden' && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)) failures.push('Number and unit are clipped');
              }
            }
            const primary = root.querySelector('#python-start-secondary');
            if (primary) { const r = primary.getBoundingClientRect(); if (r.bottom > innerHeight || r.top < 0) failures.push('Python Run is outside the first screen'); }
            const tabs = [...root.querySelectorAll('.settings-tab')].filter(visible);
            for (let i = 1; i < tabs.length; i++) {
              const a = tabs[i-1].getBoundingClientRect(), b = tabs[i].getBoundingClientRect();
              if (a.right > b.left + 1 && Math.abs(a.top - b.top) < 2) failures.push('Settings tabs overlap');
            }
            return { view:'${view}', pane:'${pane}', viewport:[innerWidth,innerHeight], controls:controls.length, failures };
          })()`);
          pages.push({ mode, width, height, zoom, font, ...result });
          failures.push(...result.failures.map(issue => `${width}/${zoom}/${font}/${view}/${pane}: ${issue}`));
          await capture(`${mode}-${width}-${zoom}-${font}-${view}${pane ? '-' + pane : ''}`);
        }
      }
    }
    }

    window.setContentSize(1360, 860, false);
    window.webContents.setZoomFactor(1.1);
    await preference('#ui-font-scale', '1');
    await activateView(window, 'settings');
    await evaluate("document.querySelector('[data-settings-tab=appearance]').click(); document.querySelector('.content-scroll').scrollTop = 0");
    await evaluate("document.querySelector('#ui-startup-view').focus(); document.querySelector('#ui-startup-view').showPicker()");
    await settle();
    const picker = await evaluate(`(() => {
      const el = document.querySelector('#ui-startup-view');
      const s = getComputedStyle(el, '::picker(select)');
      return { open:el.matches(':open'), native:getComputedStyle(el).appearance, shape:s.getPropertyValue('corner-shape'), background:s.backgroundColor };
    })()`);
    if (!(picker as { open: boolean }).open) failures.push('Native dropdown did not open');
    await capture('dropdown-open');
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key:'End', code:'End', windowsVirtualKeyCode:35 });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
    await settle();
    if (await evaluate("document.querySelector('#ui-startup-view').value") !== 'last') failures.push('Native dropdown keyboard selection did not commit');

    await preference('#ui-reduced-motion', true);
    const reduced = await evaluate<number>("parseFloat(getComputedStyle(document.querySelector('#ui-startup-view')).transitionDuration)");
    if (reduced > 0.001) failures.push('Reduce motion preference does not suppress control transitions');
    return { ok:failures.length === 0, failures, pages, picker, reducedMotionSeconds:reduced };
  } finally {
    await preference('#ui-font-scale', originalPreferences.font);
    await preference('#ui-language', originalPreferences.language);
    await preference('#ui-startup-view', originalPreferences.startup);
    await preference('#ui-reduced-motion', originalPreferences.reduced);
    await preference('#ui-experience-mode', originalPreferences.mode);
    window.webContents.setZoomFactor(originalZoom);
    window.setContentSize(originalSize.width, originalSize.height, false);
  }
}
