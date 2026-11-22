import type { BrowserWindow } from "electron";

import { activateVisualView, waitForVisualState } from "./visual-navigation.js";

export async function verifyOverviewActivity(window: BrowserWindow): Promise<Readonly<Record<string, unknown>>> {
  await activateVisualView(window, "overview");
  await waitForVisualState(window, "document.querySelectorAll('#home-active-work-carousel .active-work-line').length>=2", "active task fixtures");
  const nativeBoundsBefore = window.getBounds();
  const checks = await window.webContents.executeJavaScript(`(async () => {
    const carousel=document.querySelector('#home-active-work-carousel');
    const content=document.querySelector('.content-scroll');
    const rows=()=>[...carousel.querySelectorAll('.active-work-line')];
    const selected=()=>rows().find(row=>row.getAttribute('aria-selected')==='true');
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const key=async key=>{carousel.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await frame();};
    const wait=async predicate=>{const deadline=Date.now()+3000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));return predicate();};
    await key('Home');
    const first=selected(); const total=Number(first.getAttribute('aria-setsize'));
    const contentTop=content.scrollTop; const height=content.scrollHeight;
    let escapedWheels=0; const outside=()=>escapedWheels++; content.addEventListener('wheel',outside);
    const wheel=delta=>{const event=new WheelEvent('wheel',{deltaY:delta,bubbles:true,cancelable:true});carousel.dispatchEvent(event);return event.defaultPrevented;};
    const top=wheel(-120);await frame();const stayedFirst=selected().getAttribute('aria-posinset')==='1';
    const forward=wheel(120);await frame();const moved=selected().getAttribute('aria-posinset')==='2';
    const retained=first.isConnected&&rows().includes(first);
    await key('End');const bottom=wheel(120);await frame();const stayedLast=Number(selected().getAttribute('aria-posinset'))===total;
    content.removeEventListener('wheel',outside);
    const wheelContained=top&&forward&&bottom&&stayedFirst&&moved&&stayedLast&&escapedWheels===0&&content.scrollTop===contentTop&&content.scrollHeight===height;
    const blocked=rows().some(row=>row.dataset.activeWorkId==='task:task-visual-sample-clipboard'&&row.textContent.includes('Blocked'));
    await key('Home');
    let target=rows().find(row=>row.dataset.activeWorkId==='task:task-visual-agent-hub');
    if(target.getAttribute('aria-selected')!=='true'){target.click();await frame();}
    target=selected();
    const progress=document.querySelector('#v2-active-progress');
    const detail=await window.sovereign.getTaskDetail('task-visual-agent-hub');
    const percent=detail.task.progress.current / detail.task.progress.total * 100;
    const progressTruthful=!progress.hidden&&Number(progress.getAttribute('aria-valuenow'))===Math.round(percent)&&Math.abs(parseFloat(document.querySelector('#v2-active-progress-fill').style.width)-percent)<0.001;
    const knownTask=target.querySelector('.active-work-line-title').textContent==='Build task and Agent hub'&&
      target.querySelector('.active-work-line-detail').textContent.includes('heartbeat');
    const position=document.querySelector('#v2-active-position').textContent===target.getAttribute('aria-posinset')+' / '+target.getAttribute('aria-setsize');
    await key('Enter');
    const navigation=await wait(()=>document.querySelector('#view-tasks').classList.contains('is-active')&&document.querySelector('#task-detail-title').textContent==='Build task and Agent hub');
    document.querySelector('.navigation-item[data-view="overview"]').click();await frame();
    const overview=document.querySelector('#view-overview');
    const state=await window.sovereign.getState();
    const activeProfile=state.activeDesktopWorkspace?.permissionProfile??state.permissionProfile;
    const labels={observe:'Read only',workspace:'Work in this folder',consequential:'Ask for high-risk actions',bypass:'Bypass confirmations'};
    return {wheelContained,retained,blocked,progressTruthful,knownTask,position,navigation,
      twoClients:overview.querySelectorAll('.v2-connection-card').length===2,
      noHistoryDump:overview.querySelector('#overview-run-list,#runs-list')===null,
      permission:document.querySelector('#home-permission').textContent===labels[activeProfile],
      approvals:!!document.querySelector('#v2-pending-count').textContent.trim(),
      noClientInference:document.querySelector('#web-agent-client').textContent==='Tunnel ready'&&document.querySelector('#gemini-status').textContent==='Not configured'};
  })()`, true) as Record<string, boolean>;
  const nativeBoundsAfter=window.getBounds();
  const nativeWindowStable=(Object.keys(nativeBoundsBefore) as (keyof typeof nativeBoundsBefore)[]).every(key=>nativeBoundsBefore[key]===nativeBoundsAfter[key]);
  return {ok:Object.values(checks).every(Boolean)&&nativeWindowStable,checks,nativeWindowStable,nativeBoundsBefore,nativeBoundsAfter};
}
