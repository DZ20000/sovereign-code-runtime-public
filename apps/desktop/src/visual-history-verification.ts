import type { BrowserWindow } from "electron";

import { approvalFixture } from "./visual-approval-fixture.js";
import { activateVisualView, clickVisualControl, openTaskRunHistory, settleVisualRenderer, waitForVisualState } from "./visual-navigation.js";

/** Runs belong to Tasks; receipts and pending decisions belong to Approvals. */
export async function verifyHistorySurfaces(window: BrowserWindow): Promise<void> {
  await openTaskRunHistory(window);
  await waitForVisualState(window, "document.querySelectorAll('#runs-list [data-run-id]').length === 3", "three fixture runs");
  await clickVisualControl(window, '#runs-list [data-run-id="run-visual-typecheck"]');
  await waitForVisualState(window, "document.querySelector('#run-stdout')?.textContent.includes('tsc -b --pretty false')", "selected run output");
  const runs = await window.webContents.executeJavaScript(`(async () => {
    const stdout = document.querySelector('#run-stdout');
    const stderr = document.querySelector('#run-stderr');
    const stdoutTab = document.querySelector('#run-output-tab-stdout');
    const stderrTab = document.querySelector('#run-output-tab-stderr');
    const original = stdout.textContent;
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    stdoutTab.click(); stdoutTab.focus();
    stdoutTab.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true }));
    await frame();
    const right = document.activeElement === stderrTab && stderrTab.getAttribute('aria-selected') === 'true' &&
      document.querySelector('#run-output-pane-stderr').checkVisibility();
    stderrTab.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowLeft', bubbles:true, cancelable:true }));
    await frame();
    const left = document.activeElement === stdoutTab && stdoutTab.getAttribute('aria-selected') === 'true' &&
      document.querySelector('#run-output-pane-stdout').checkVisibility();
    const language = document.querySelector('#ui-language');
    language.value='zh-CN'; language.dispatchEvent(new Event('change',{bubbles:true})); await frame();
    const localized = document.documentElement.lang === 'zh-CN' && stdout.textContent === original &&
      !stdout.hasAttribute('data-i18n-placeholder') && stderr.hasAttribute('data-i18n-placeholder') &&
      stderr.textContent?.includes('stderr') && document.querySelector('#run-detail-title').textContent === 'pnpm typecheck';
    language.value='en'; language.dispatchEvent(new Event('change',{bubbles:true})); await frame();
    return { oneWorkbench:document.querySelectorAll('#runs-workbench-root').length===1,
      runIdentity:document.querySelector('#run-detail-identity').textContent.includes('run-visual-typecheck'),
      readableOutput:parseFloat(getComputedStyle(stdout).fontSize)>=11.5,
      cancelAvailable:!document.querySelector('#run-cancel').disabled,
      noLegacyRoute:document.querySelector('#view-runs')===null,
      right,left,localized,rawUnchanged:stdout.textContent===original };
  })()`, true) as Record<string, boolean>;
  if (Object.values(runs).some(value => !value)) throw new Error("Task run history failed: " + JSON.stringify(runs));

  await activateVisualView(window, "approvals");
  await clickVisualControl(window, "#v2-approvals-tab-pending");
  await waitForVisualState(window, "document.querySelectorAll('#v2-approvals-list [data-request-id]').length === 2 && document.querySelectorAll('#v2-audit-list [data-receipt-id]').length === 3", "approval and receipt lists");
  const beforeOpen = approvalFixture.opened.length;
  const beforeDecision = approvalFixture.decisions.length;
  await clickVisualControl(window, '#v2-approvals-list [data-request-id="approval-visual-001"]');
  await window.webContents.executeJavaScript("document.querySelector('#v2-approvals-list [data-request-id=\"approval-visual-queued\"]').click()", true);
  await settleVisualRenderer(window);
  if (approvalFixture.opened.length !== beforeOpen + 1 || approvalFixture.opened.at(-1) !== "approval-visual-001" || approvalFixture.decisions.length !== beforeDecision) {
    throw new Error("Opening an approval dispatched a decision or opened a queued request.");
  }
  await clickVisualControl(window, "#v2-approvals-tab-audit");
  await waitForVisualState(window, "document.querySelector('#v2-approvals-audit-pane').checkVisibility()", "visible audit records");
  const audit = await window.webContents.executeJavaScript(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const search=document.querySelector('#v2-audit-search');
    const outcome=document.querySelector('#v2-audit-outcome');
    const rows=()=>[...document.querySelectorAll('#v2-audit-list [data-receipt-id]')];
    const first=rows()[0]; first.click(); await frame();
    const selected=first.dataset.selected==='true' && document.querySelector('#v2-audit-detail').textContent.trim().length>0;
    search.value='__no_fixture_receipt__'; search.dispatchEvent(new Event('input',{bubbles:true})); await frame();
    const empty=rows().length===0 && document.querySelector('#v2-audit-list').textContent.trim().length>0;
    search.value=''; search.dispatchEvent(new Event('input',{bubbles:true}));
    outcome.value='denied'; outcome.dispatchEvent(new Event('change',{bubbles:true})); await frame();
    const filtered=rows().length===1;
    outcome.value='all'; outcome.dispatchEvent(new Event('change',{bubbles:true})); await frame();
    return { selected,empty,filtered,restored:rows().length===3,
      queuedDisabled:document.querySelector('#v2-approvals-list [data-request-id="approval-visual-queued"]').disabled,
      named:[search,outcome].every(control => !!control.getAttribute('aria-label')?.trim() ||
        [...control.labels].some(label => !!label.querySelector('span')?.textContent.trim())) };
  })()`, true) as Record<string, boolean>;
  if (Object.values(audit).some(value => !value)) throw new Error("Approvals and audit failed: " + JSON.stringify(audit));
}
