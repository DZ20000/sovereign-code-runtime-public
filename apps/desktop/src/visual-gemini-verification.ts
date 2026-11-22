import type { BrowserWindow } from "electron";
import { geminiFixture } from "./visual-gemini-fixture.js";
import { clickVisualControl, closeConnectionDrawer, openConnectionDrawer, settleVisualRenderer, waitForVisualState } from "./visual-navigation.js";

const PUBLIC_CONFIGURATION = {
  publicMcpUrl: "https://mcp.example.test/mcp",
  oauthDiscoveryUrl: "https://oauth.example.test/.well-known/openid-configuration",
  introspectionUrl: "https://oauth.example.test/introspect",
  clientId: "gemini-visual-client", loopbackPort: 0,
};
const PUBLIC_INPUTS = {
  publicMcpUrl: "gemini-public-url", oauthDiscoveryUrl: "gemini-discovery-url",
  introspectionUrl: "gemini-introspection-url", clientId: "gemini-client-id", loopbackPort: "gemini-port",
};

export async function verifyGeminiConnection(window: BrowserWindow): Promise<void> {
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true) as Promise<T>;
  const check = (passed: boolean, name: string): void => { if (!passed) throw new Error("Gemini verification failed: " + name); };
  const field = async (id: string, value: string): Promise<void> => {
    await evaluate("(() => {const input=document.getElementById(" + JSON.stringify(id) + ");input.value=" + JSON.stringify(value)
      + ";input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await settleVisualRenderer(window);
  };
  const publicFields = async (): Promise<void> => {
    for (const [key, id] of Object.entries(PUBLIC_INPUTS)) await field(id, String(PUBLIC_CONFIGURATION[key as keyof typeof PUBLIC_CONFIGURATION]));
  };
  const closeDrawer = async (): Promise<void> => {
    if (await evaluate<boolean>("document.querySelector('#connection-drawer').open")) await closeConnectionDrawer(window);
  };
  const save = async (): Promise<void> => {
    const before=geminiFixture.requests.length;
    await clickVisualControl(window, "#gemini-save");
    await waitForVisualState(window, "document.querySelector('#gemini-save').disabled && document.querySelector('#gemini-configuration-state').textContent==='Saved' && document.querySelector('#gemini-error').hidden", "Gemini save settled");
    check(geminiFixture.requests.length===before+1,"save dispatches exactly one configuration");
  };
  const replaceOwner = async (value: string): Promise<void> => {
    await clickVisualControl(window,"#gemini-protected-open");
    await clickVisualControl(window,"#gemini-replace-owner");
    await field("gemini-owner-subject",value);
    await clickVisualControl(window,"#gemini-protected-apply");
  };

  await openConnectionDrawer(window,"gemini");
  await waitForVisualState(window,"document.querySelector('#gemini-status').textContent==='Not configured'","Gemini configuration ready");
  const initial=await window.webContents.executeJavaScript(`(() => ({
    panel:!document.querySelector('#connection-panel-gemini').hidden&&document.querySelector('#connection-panel-chatgpt').hidden,
    fields:document.querySelectorAll('#gemini-config-form input:not([type=password])').length===5,
    noSecrets:document.querySelector('#gemini-owner-subject').value===''&&document.querySelector('#gemini-introspection-authorization').value==='',
    oneSave:[...document.querySelectorAll('#connection-panel-gemini .button-primary')].filter(el=>el.checkVisibility()).length===1,
    separateAction:document.querySelector('#gemini-save')!==document.querySelector('#gemini-primary')
  }))()`,true) as Record<string,boolean>;
  check(Object.values(initial).every(Boolean),"seven-field configuration and protected inputs");
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__visualCopiedPublicUrl=value;}}})");

  await clickVisualControl(window,"#gemini-import");
  await field("gemini-import-json",JSON.stringify({...PUBLIC_CONFIGURATION,ownerSubject:"visual-secret-rejected"}));
  await clickVisualControl(window,"#gemini-import-preview");
  check(await evaluate<boolean>("!document.querySelector('#gemini-import-error').hidden&&document.querySelector('#gemini-import-apply').disabled&&!document.querySelector('#gemini-import-error').textContent.includes('visual-secret-rejected')"),"import refuses secret fields with a fixed error");
  await field("gemini-import-json",JSON.stringify(PUBLIC_CONFIGURATION));
  await clickVisualControl(window,"#gemini-import-preview");
  check(await evaluate<boolean>("!document.querySelector('#gemini-import-fields').hidden&&!document.querySelector('#gemini-import-apply').disabled&&document.querySelector('#gemini-client-id').value===''"),"import preview does not alter the form");
  await clickVisualControl(window,"#gemini-import-cancel");
  check(await evaluate<boolean>("document.querySelector('#gemini-client-id').value===''"),"import Cancel preserves the draft");
  await clickVisualControl(window,"#gemini-import");
  await field("gemini-import-json",JSON.stringify(PUBLIC_CONFIGURATION));
  await clickVisualControl(window,"#gemini-import-preview");
  await clickVisualControl(window,"#gemini-import-apply");
  check(await evaluate<boolean>("document.querySelector('#gemini-client-id').value==='gemini-visual-client'&&!document.querySelector('#gemini-import-dialog').open"),"import Apply fills only the form");
  await clickVisualControl(window,"#gemini-presets");
  await clickVisualControl(window,"#gemini-preset-example");
  check(await evaluate<boolean>("document.querySelector('#gemini-public-url').value==='https://mcp.example.com/gemini'"),"example preset fills public fields");
  await clickVisualControl(window,"#gemini-presets");
  await clickVisualControl(window,"#gemini-preset-manual");
  check(await evaluate<boolean>("document.querySelector('#gemini-public-url').value===''&&document.querySelector('#gemini-owner-subject').value===''"),"manual preset clears only public fields");
  check(geminiFixture.requests.length===0&&geminiFixture.starts===0,"import and presets do not save or start");
  await publicFields();

  for (const cancel of ["button","escape"] as const) {
    await clickVisualControl(window,"#gemini-protected-open");
    await clickVisualControl(window,"#gemini-replace-owner");
    await field("gemini-owner-subject","visual-cancelled-value");
    if(cancel==="button") await clickVisualControl(window,"#gemini-protected-cancel");
    else {
      for (const type of ["keyDown","keyUp"] as const) await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent",{type,key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await settleVisualRenderer(window);
    }
    check(await evaluate<boolean>("!document.querySelector('#gemini-protected-dialog').open&&document.querySelector('#connection-drawer').open&&document.querySelector('#gemini-owner-subject').value===''"),"protected " + cancel + " restores the snapshot");
  }
  await clickVisualControl(window,"#gemini-protected-open");
  await clickVisualControl(window,"#gemini-replace-owner");
  await field("gemini-owner-subject","visual-owner-only");
  await clickVisualControl(window,"#gemini-replace-authorization");
  await field("gemini-introspection-authorization","Bearer visual-token-only");
  await clickVisualControl(window,"#gemini-protected-apply");
  check(geminiFixture.requests.length===0,"protected Apply is staged until Save");
  await closeDrawer();await openConnectionDrawer(window,"chatgpt");await closeDrawer();await openConnectionDrawer(window,"gemini");
  await evaluate("document.querySelector('#gemini-refresh').click()");await settleVisualRenderer(window);
  check(await evaluate<boolean>("document.querySelector('#gemini-client-id').value==='gemini-visual-client'&&document.querySelector('#gemini-owner-state').textContent==='Replacement ready to save'&&document.querySelector('#gemini-owner-subject').value===''&&document.querySelector('#gemini-owner-subject').type==='password'"),"ordinary and protected drafts survive provider changes and refresh");

  geminiFixture.failNextSave=true;
  await clickVisualControl(window,"#gemini-save");
  await waitForVisualState(window,"!document.querySelector('#gemini-error').hidden","fixed Gemini save error");
  check(await evaluate<boolean>("document.querySelector('#gemini-error').textContent==='Could not save Gemini configuration.'&&document.querySelector('#gemini-owner-state').textContent==='Replacement ready to save'&&!document.body.innerText.includes('visual-credential-must-not-appear')&&!JSON.stringify(localStorage).includes('visual-token-only')"),"save failure is sanitized and keeps unsaved secrets");
  await clickVisualControl(window,"#gemini-protected-open");
  check(await evaluate<boolean>("document.querySelector('#gemini-owner-subject').value==='visual-owner-only'&&document.querySelector('#gemini-introspection-authorization').value==='Bearer visual-token-only'"),"failed Save retains both unsaved protected drafts");
  await clickVisualControl(window,"#gemini-protected-cancel");
  await save();
  const first=geminiFixture.requests.at(-1)!;
  check(first.ownerSubject.action==="replace"&&first.ownerSubject.value==="visual-owner-only"&&first.introspectionAuthorization.action==="replace"&&first.introspectionAuthorization.value==="Bearer visual-token-only"&&first.publicMcpUrl===PUBLIC_CONFIGURATION.publicMcpUrl&&first.loopbackPort===0,"exact configure payload");
  check(geminiFixture.starts===0&&geminiFixture.status.phase==="saved","Save does not start a listener");
  check(await evaluate<boolean>("document.querySelector('#gemini-owner-subject').value===''&&document.querySelector('#gemini-introspection-authorization').value===''&&document.querySelector('#gemini-owner-state').textContent==='Saved securely · not displayed'&&!JSON.stringify(localStorage).includes('visual-owner-only')&&!JSON.stringify(localStorage).includes('visual-token-only')"),"successful Save clears protected inputs and never persists them in the renderer");
  await closeDrawer();
  await clickVisualControl(window,"#gemini-copy-url");
  check(await evaluate<boolean>("window.__visualCopiedPublicUrl==='https://mcp.example.test/mcp'"),"Copy uses only the public address");
  await clickVisualControl(window,"#gemini-primary");
  await waitForVisualState(window,"document.querySelector('#gemini-status').textContent==='Listening locally'","Gemini listening");
  check(geminiFixture.starts===1&&geminiFixture.status.phase==="listening","Start dispatches once");
  check(await evaluate<boolean>("document.querySelector('#web-agent-client').textContent==='Tunnel ready'&&document.querySelector('#connections-session-count').textContent==='2'"),"generic sessions are not assigned to Gemini or ChatGPT");

  await openConnectionDrawer(window,"gemini");
  await field("gemini-client-id","gemini-visual-updated");
  await save();
  const kept=geminiFixture.requests.at(-1)!;
  check(kept.ownerSubject.action==="keep"&&kept.introspectionAuthorization.action==="keep"&&kept.clientId==="gemini-visual-updated","blank protected updates keep saved values");
  await clickVisualControl(window,"#gemini-protected-open");
  await clickVisualControl(window,"#gemini-forget-owner");
  await clickVisualControl(window,"#gemini-protected-apply");
  await save();
  const forgotten=geminiFixture.requests.at(-1)!;
  check(forgotten.ownerSubject.action==="forget"&&!geminiFixture.status.hasOwnerSubject&&forgotten.introspectionAuthorization.action==="keep"&&geminiFixture.status.hasIntrospectionAuthorization,"Clear affects only its protected value");
  await closeDrawer();
  await clickVisualControl(window,"#gemini-primary");
  check(geminiFixture.starts===1&&await evaluate<boolean>("document.querySelector('#connection-drawer').open"),"incomplete configuration opens Configure without starting");
  await replaceOwner("short");await save();await closeDrawer();
  await clickVisualControl(window,"#gemini-primary");
  await waitForVisualState(window,"document.querySelector('#gemini-status').textContent==='Listening locally'","replacement listener started");
  await clickVisualControl(window,"#gemini-primary");
  await waitForVisualState(window,"document.querySelector('#gemini-status').textContent==='Saved'","Gemini stopped");
  check(geminiFixture.stops===1&&geminiFixture.status.listenEndpoint===null,"Stop closes the fixture listener");

  geminiFixture.status={...geminiFixture.status,phase:"error",lastError:"The OAuth server configuration could not be verified."};
  await openConnectionDrawer(window,"gemini");
  await waitForVisualState(window,"document.querySelector('#gemini-error').textContent==='The OAuth server configuration could not be verified.'","fixed backend error");
  geminiFixture.status={...geminiFixture.status,phase:"saved",lastError:null};
  await evaluate("document.querySelector('#gemini-refresh').click()");
  await waitForVisualState(window,"document.querySelector('#gemini-error').hidden","Gemini error cleared");
  await closeDrawer();
}
