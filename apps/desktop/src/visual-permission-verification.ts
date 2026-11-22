import type { BrowserWindow } from "electron";

import {
  activateVisualSettings, activateVisualView, clickVisualControl, settleVisualRenderer, waitForVisualState,
} from "./visual-navigation.js";

interface PermissionSnapshot {
  readonly permissionProfile: string;
  readonly rememberedPermissionProfile: string;
  readonly unattendedWorkspaceAccess: boolean;
}

/** Exercises the single settings owner; changing presentation never grants permission. */
export async function verifyPermissionLifecycle(window: BrowserWindow, waitForRenderer: () => Promise<void>): Promise<void> {
  const scopeId = await window.webContents.executeJavaScript("window.sovereign.getState().then(state=>state.activeDesktopWorkspace?.id??null)",true) as string | null;
  const contextExpression = scopeId === null ? "state" : "(state.activeDesktopWorkspace?.id==="+JSON.stringify(scopeId)+"?state.activeDesktopWorkspace:null)";
  const read = (): Promise<PermissionSnapshot> => window.webContents.executeJavaScript(
    "window.sovereign.getState().then(state=>{const context="+contextExpression+";if(!context)throw new Error('Permission scope changed');return {permissionProfile:context.permissionProfile,rememberedPermissionProfile:context.rememberedPermissionProfile,unattendedWorkspaceAccess:state.unattendedWorkspaceAccess};})", true,
  ) as Promise<PermissionSnapshot>;
  const original = await read();
  const selection = async (profile: string, remembered: string): Promise<void> => {
    await waitForVisualState(window,
      "(async () => { const state=await window.sovereign.getState(); const snapshot="+contextExpression+"; "
        + "const group=document.querySelector('#settings-permission-profiles'); const bypass=document.querySelector('#settings-bypass-toggle'); "
        + "const selected=[...group.querySelectorAll('[data-permission-profile]')].filter(el=>el.getAttribute('aria-pressed')==='true'); "
        + "return snapshot.permissionProfile === " + JSON.stringify(profile)
        + " && snapshot.rememberedPermissionProfile === " + JSON.stringify(remembered)
        + " && group.dataset.workspaceScope==="+JSON.stringify(scopeId??"default")+" && document.querySelectorAll('#settings-permission-profiles').length===1 && document.querySelector('#web-permission-profiles')===null "
        + " && (" + JSON.stringify(profile) + " === 'bypass' ? selected.length===0 && bypass.getAttribute('aria-pressed')==='true' "
        + ": selected.length===1 && selected[0].dataset.permissionProfile === " + JSON.stringify(profile) + " && bypass.getAttribute('aria-pressed')==='false'); })()",
      "one authoritative permission selection",
    );
  };
  const applyProfile = async (profile: string): Promise<void> => {
    await activateVisualSettings(window, "security");
    if ((await read()).permissionProfile === profile) return;
    await clickVisualControl(window, profile === "bypass" ? "#settings-bypass-toggle" : '#settings-permission-profiles [data-permission-profile="' + profile + '"]');
    await clickVisualControl(window, "#v2-save-workspace");
    await waitForVisualState(window, "window.sovereign.getState().then(state=>("+contextExpression+")?.permissionProfile === " + JSON.stringify(profile) + ")", "permission applied");
  };
  const unattended = async (value: boolean): Promise<void> => {
    await activateVisualSettings(window, "appearance");
    await window.webContents.executeJavaScript(
      "(() => { const input=document.querySelector('#unattended-workspace-access'); input.checked=" + JSON.stringify(value)
        + "; input.dispatchEvent(new Event('change',{bubbles:true})); })()", true,
    );
    await waitForVisualState(window, "window.sovereign.getState().then(state=>state.unattendedWorkspaceAccess === " + JSON.stringify(value) + ")", "workspace restore preference");
  };

  await applyProfile("consequential");
  await selection("consequential", "consequential");
  for (const enabled of [false, true]) {
    await unattended(enabled);
    const snapshot = await read();
    if (snapshot.permissionProfile !== "consequential" || snapshot.rememberedPermissionProfile !== "consequential") {
      throw new Error("Changing automatic workspace restore changed the current permission.");
    }
  }
  await applyProfile("bypass");
  await selection("bypass", "consequential");
  await activateVisualView(window, "overview");
  await clickVisualControl(window, "#v2-mode-simple");
  await waitForVisualState(window,
    "document.documentElement.dataset.experienceMode === 'simple' && document.querySelector('#home-permission')?.textContent==='Bypass confirmations'",
    "L4 remains visible in the simple summary",
  );
  await clickVisualControl(window, "#v2-mode-expand");
  if ((await read()).permissionProfile !== "bypass") throw new Error("Mode switching revoked or replaced the actual permission.");

  const loaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  window.webContents.reload();
  await loaded;
  await waitForRenderer();
  await activateVisualSettings(window, "security");
  await selection("bypass", "consequential");
  await clickVisualControl(window, "#settings-bypass-toggle");
  await clickVisualControl(window, "#v2-save-workspace");
  await selection("consequential", "consequential");
  await activateVisualView(window, "overview");
  await clickVisualControl(window, "#v2-mode-simple");
  await waitForVisualState(window, "document.querySelector('#home-permission')?.textContent==='Ask for high-risk actions'", "remembered L3 shown after L4 is revoked");
  await clickVisualControl(window, "#v2-mode-expand");
  await unattended(original.unattendedWorkspaceAccess);
  await applyProfile(original.permissionProfile);
  await settleVisualRenderer(window);
}
