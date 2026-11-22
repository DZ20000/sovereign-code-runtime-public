import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow } from "electron";

import { restoreApprovalWindowFixture, setApprovalWindowFixture, visualApproval } from "./visual-approval-fixture.js";
import { VISUAL_LANGUAGES, VISUAL_THEMES } from "./visual-matrix.js";
import { settleVisualRenderer, waitForVisualState } from "./visual-navigation.js";
import type { DesktopApprovalView } from "./shared.js";

type Risk = "normal" | "destructive" | "handoff";
type State = "pending" | "flood" | "expired" | "unavailable" | "failure" | "submitting";
const SCENARIOS: readonly { risk: Risk; state: State }[] = [
  { risk: "normal", state: "pending" }, { risk: "destructive", state: "pending" }, { risk: "handoff", state: "pending" },
  { risk: "normal", state: "flood" }, { risk: "normal", state: "expired" }, { risk: "normal", state: "unavailable" },
  { risk: "normal", state: "failure" }, { risk: "destructive", state: "failure" }, { risk: "handoff", state: "failure" },
  { risk: "normal", state: "submitting" },
];

interface ApprovalLayout {
  readonly width: number;
  readonly height: number;
  readonly horizontalOverflow: boolean;
  readonly buttonsFit: boolean;
  readonly contentHeight: number;
  readonly phase: string;
  readonly risk: string;
  readonly allowHidden: boolean;
  readonly allowDisabled: boolean;
  readonly denyDisabled: boolean;
  readonly closeDisabled: boolean;
  readonly returnVisible: boolean;
  readonly dropVisible: boolean;
  readonly requester: string;
  readonly target: string;
  readonly detail: string;
  readonly language: string;
  readonly theme: string;
  readonly secretLeaked: boolean;
  readonly feedback: string;
}

export async function verifyApprovalWindows(options: {
  readonly rendererOrigin: string;
  readonly preloadPath: string;
  readonly outputRoot: string;
}): Promise<void> {
  const window = new BrowserWindow({
    width: 560, height: 480, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
    title: "Sovereign isolated approval verification",
    webPreferences: {
      preload: options.preloadPath, offscreen: true, zoomFactor: 1, contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      devTools: false, backgroundThrottling: false,
    },
  });
  const consoleProblems: string[] = [];
  window.webContents.on("console-message", (event) => {
    const detail = event as unknown as { readonly level?: string; readonly message?: string };
    if (detail.message && (detail.level === "error" || /uncaught|error|failed/iu.test(detail.message))) consoleProblems.push(detail.message);
  });
  window.webContents.on("render-process-gone", (_event, details) => consoleProblems.push("render-process-gone:" + details.reason));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const records: unknown[] = [];
  let originalPreferences: string | null = null;
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true) as Promise<T>;
  try {
    await window.loadURL(options.rendererOrigin + "approval.html");
    originalPreferences = await evaluate<string | null>("localStorage.getItem('sovereign.ui.settings.v1')");
    const cells = VISUAL_LANGUAGES.flatMap((language) => VISUAL_THEMES.flatMap((theme) =>
      [{ width: 560, height: 480 }, { width: 480, height: 340 }].map((viewport) => ({ language, theme, fontScale: 1, uiScale: 1, ...viewport })),
    ));
    cells.push({ language: "zh-CN", theme: "dark", width: 480, height: 340, fontScale: 1.3, uiScale: 1.5 });
    for (const cell of cells) {
      window.webContents.setZoomFactor(1);
      window.setContentSize(cell.width, cell.height, false);
      for (const scenario of SCENARIOS) {
        const context = {
          requesterId: "fixture-agent-1", workspaceId: "fixture-workspace", permissionLevel: "consequential" as const,
          destructive: scenario.risk === "destructive", sideEffect: "process",
          target: scenario.risk === "destructive"
            ? { kind: "path" as const, value: "C:\\Projects\\demo\\temporary-output.txt" }
            : { kind: "command" as const, value: scenario.risk === "handoff" ? "Fixture administrator action" : "pnpm typecheck" },
          ...(scenario.risk === "handoff" ? { administratorRequired: true as const } : {}),
        };
        const request: DesktopApprovalView = {
          ...visualApproval, context, burstDetected: scenario.state === "flood",
          expiresAt: new Date(Date.now() + (scenario.state === "expired" ? -1_000 : 60_000)).toISOString(),
        };
        const decisions: string[] = [];
        const dismissals: boolean[] = [];
        let acknowledge: (() => void) | undefined;
        setApprovalWindowFixture(
          () => scenario.state === "unavailable" ? null : request,
          (id, decision) => {
            if (id !== request.id) throw new Error("The approval request identity changed.");
            decisions.push(decision);
            if (scenario.state === "failure") throw new Error("visual-credential-must-not-appear");
            if (scenario.state === "submitting") return new Promise<void>((resolve) => { acknowledge = resolve; });
            return undefined;
          },
          (back) => { dismissals.push(back); },
        );
        try {
          await evaluate("localStorage.setItem('sovereign.ui.settings.v1'," + JSON.stringify(JSON.stringify({
            language: cell.language, theme: cell.theme, fontScale: cell.fontScale, uiScale: cell.uiScale, reducedMotion: true,
          })) + ")");
          await window.loadURL(options.rendererOrigin + "approval.html");
          const firstPhase = scenario.state === "unavailable" ? "unavailable" : scenario.state === "expired" ? "expired" : "pending";
          await waitForVisualState(window, "document.querySelector('.approval-shell')?.dataset.phase===" + JSON.stringify(firstPhase), "approval initial phase");
          if (scenario.state === "failure" || scenario.state === "submitting") {
            await evaluate("document.querySelector('#approval-allow').click()");
          }
          const expectedPhase = scenario.state === "failure" ? "uncertain" : scenario.state === "submitting" ? "submitting" : firstPhase;
          await waitForVisualState(window, "document.querySelector('.approval-shell')?.dataset.phase===" + JSON.stringify(expectedPhase), "approval decision phase");
          await settleVisualRenderer(window);
          const layout = await evaluate<ApprovalLayout>(
            "(() => { const shell=document.querySelector('.approval-shell');const buttons=[...document.querySelectorAll('.approval-shell button')].filter(el=>el.checkVisibility());"
            + "const allow=document.querySelector('#approval-allow'),deny=document.querySelector('#approval-deny'),close=document.querySelector('#approval-close');return {"
            + "width:innerWidth,height:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,"
            + "buttonsFit:buttons.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;}),"
            + "contentHeight:document.querySelector('.approval-content').clientHeight,phase:shell.dataset.phase,risk:shell.dataset.risk,"
            + "allowHidden:allow.hidden,allowDisabled:allow.disabled,denyDisabled:deny.disabled,closeDisabled:close.disabled,"
            + "returnVisible:document.querySelector('#approval-return').checkVisibility(),dropVisible:document.querySelector('#approval-drop').checkVisibility(),"
            + "requester:document.querySelector('#approval-requester').textContent,target:document.querySelector('#approval-target').textContent,detail:document.querySelector('#approval-detail').textContent,"
            + "language:document.documentElement.lang,theme:document.documentElement.dataset.theme,"
            + "secretLeaked:document.body.innerText.includes('visual-credential-must-not-appear'),feedback:document.querySelector('#approval-feedback').textContent};})()",
          );
          const blocked = ["expired", "unavailable", "failure"].includes(scenario.state);
          const submitting = scenario.state === "submitting";
          if (window.webContents.getZoomFactor() !== 1 || layout.width !== cell.width || layout.height !== cell.height
              || layout.language !== cell.language || layout.theme !== cell.theme || layout.horizontalOverflow
              || !layout.buttonsFit || layout.contentHeight < 24 || layout.phase !== expectedPhase
              || layout.risk !== (scenario.state === "unavailable" ? "normal" : scenario.risk)
              || layout.allowHidden !== blocked || layout.allowDisabled !== (blocked || submitting)
              || layout.denyDisabled !== submitting || layout.closeDisabled !== submitting
              || layout.returnVisible !== ["failure", "unavailable"].includes(scenario.state)
              || layout.dropVisible !== (scenario.state === "flood")
              || layout.secretLeaked || (scenario.state === "failure" && layout.feedback.trim().length === 0)
              || (scenario.state !== "unavailable" && (layout.requester !== context.requesterId || layout.target !== context.target.value || layout.detail !== request.detail))) {
            throw new Error("Approval visual state failed: " + JSON.stringify({ cell, scenario, layout }));
          }
          const relativePath = join("approval", cell.language, cell.theme, cell.width + "x" + cell.height + "-font-" + cell.fontScale + "-ui-" + cell.uiScale, scenario.risk + "-" + scenario.state + ".png");
          await mkdir(dirname(join(options.outputRoot, relativePath)), { recursive: true });
          await writeFile(join(options.outputRoot, relativePath), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
          if (scenario.state === "pending" || scenario.state === "flood") {
            await evaluate("document.querySelector(" + JSON.stringify(scenario.state === "flood" ? "#approval-drop" : "#approval-allow") + ").click()");
            await waitForVisualState(window, "document.querySelector('.approval-shell')?.dataset.phase==='submitting'", "single approval attempt");
            const expectedDecision = scenario.state === "flood" ? "drop-to-l1" : scenario.risk === "handoff" ? "deny" : "allow-once";
            if (decisions.length !== 1 || decisions[0] !== expectedDecision) throw new Error("Approval action dispatched a wrong or duplicate decision.");
          }
          const beforeReplay = decisions.length;
          await evaluate("document.querySelector('#approval-allow').click(); document.querySelector('#approval-allow').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
          await settleVisualRenderer(window);
          if (decisions.length !== beforeReplay) throw new Error("An inactive approval replayed a decision.");
          if (scenario.state === "failure" || scenario.state === "unavailable") {
            await evaluate("document.querySelector('#approval-return').click()");
            await settleVisualRenderer(window);
            if (dismissals.length !== 1 || dismissals[0] !== true) throw new Error("Approval recovery did not return to the center.");
          }
          records.push({ ...cell, ...scenario, relativePath: relativePath.replaceAll("\\", "/"), layout, decisions, dismissals });
        } finally {
          acknowledge?.();
        }
      }
    }
    if (consoleProblems.length > 0) throw new Error("Approval renderer reported errors: " + JSON.stringify(consoleProblems));
    await writeFile(join(options.outputRoot, "approval-states.json"), JSON.stringify({ ok: true, records, consoleProblems }, null, 2));
  } finally {
    restoreApprovalWindowFixture();
    if (!window.isDestroyed()) {
      await evaluate(originalPreferences === null ? "localStorage.removeItem('sovereign.ui.settings.v1')"
        : "localStorage.setItem('sovereign.ui.settings.v1'," + JSON.stringify(originalPreferences) + ")").catch(() => undefined);
      window.destroy();
    }
  }
}
