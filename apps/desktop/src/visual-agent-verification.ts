import type { BrowserWindow } from "electron";

import { closeConnectionDrawer, openConnectionDrawer, settleVisualRenderer } from "./visual-navigation.js";

/** Connection details do not create a second permission editor or reveal stored keys. */
export async function verifyAgentConnectionSurface(window: BrowserWindow): Promise<void> {
  await openConnectionDrawer(window, "chatgpt");
  const result = await window.webContents.executeJavaScript(`(async () => {
    const drawer=document.querySelector('#connection-drawer');
    const key=document.querySelector('#secure-tunnel-api-key');
    const proxy=document.querySelector('#secure-tunnel-proxy');
    const backup=document.querySelector('#secure-tunnel-backup-proxy');
    const fold=document.querySelector('#connection-panel-chatgpt details');
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const before={ id:document.querySelector('#secure-tunnel-id').value, key:key.value, proxy:proxy.value, backup:backup.value };
    const initial={ dialog:drawer instanceof HTMLDialogElement && drawer.open && drawer.dataset.provider==='chatgpt',
      onePermissionOwner:document.querySelector('#web-permission-profiles')===null && document.querySelectorAll('#settings-permission-profiles').length===1,
      secretsHidden:key.type==='password'&&proxy.type==='password'&&backup.type==='password'&&key.value===''&&proxy.value===''&&backup.value==='',
      folded:fold instanceof HTMLDetailsElement && !fold.open,
      truthful:document.querySelector('#web-agent-client').textContent==='Tunnel ready',
      ownPanel:!document.querySelector('#connection-panel-chatgpt').hidden&&document.querySelector('#connection-panel-gemini').hidden,
      storedKey:document.querySelector('#secure-tunnel-key-storage').textContent.includes('Windows DPAPI') };
    fold.open=true;
    const language=document.querySelector('#ui-language'); language.value='zh-CN';language.dispatchEvent(new Event('change',{bubbles:true}));await frame();
    const chinese=document.documentElement.lang==='zh-CN'&&fold.querySelector('summary').textContent==='高级连接选项'&&
      document.querySelector('#secure-tunnel-key-storage').textContent.includes('Windows DPAPI')&&
      document.querySelector('#web-agent-client').textContent==='隧道已就绪';
    const valuesUnchanged=key.value===before.key&&proxy.value===before.proxy&&backup.value===before.backup&&document.querySelector('#secure-tunnel-id').value===before.id;
    language.value='en';language.dispatchEvent(new Event('change',{bubbles:true}));await frame();
    fold.open=false;
    return {...initial,chinese,valuesUnchanged,restored:document.querySelector('#web-agent-client').textContent==='Tunnel ready'};
  })()`, true) as Record<string, boolean>;
  if (Object.values(result).some(value => !value)) throw new Error("ChatGPT drawer contract failed: " + JSON.stringify(result));
  await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type:"keyDown", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
  await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type:"keyUp", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
  await settleVisualRenderer(window);
  const returned = await window.webContents.executeJavaScript("!document.querySelector('#connection-drawer').open && document.activeElement?.id==='v2-chatgpt-config'", true) as boolean;
  if (!returned) throw new Error("Closing the connection drawer did not restore its trigger focus.");
  await openConnectionDrawer(window, "chatgpt");
  await closeConnectionDrawer(window);
}
