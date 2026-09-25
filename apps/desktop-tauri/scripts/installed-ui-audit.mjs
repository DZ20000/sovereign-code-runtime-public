#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { readInstalledRendererState } from "./installed-renderer-state-audit.mjs";
import { buildInstalledUiAuditPowerShell } from "./installed-ui-audit-powershell.mjs";

export const INSTALLED_UI_AUDIT_SCHEMA_VERSION = "scr.installed-ui-audit/v1";
export const DEFAULT_INSTALLED_UI_IDENTIFIER = "com.sovereign.runtime";
export const DEFAULT_INSTALLED_UI_PRODUCT_NAME = "Sovereign Code Runtime";
export const MAX_INSTALLED_UI_SCREENSHOT_BYTES = 64 * 1024 * 1024;

const INSTALLED_UI_AUDIT_PARENT_TIMEOUT_MS = 30_000;
const INSTALLED_UI_AUDIT_ACCESSIBILITY_DEADLINE_MS = 20_000;
const INSTALLED_UI_AUDIT_ACCESSIBILITY_LIMIT_STAGES = new Set([
  "accessibility-budget",
  "automation-root",
  "process-descendants",
  "element-properties",
  "element-limit",
]);

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;

function runPowerShellFromStdin(
  script,
  timeoutMs = INSTALLED_UI_AUDIT_PARENT_TIMEOUT_MS,
) {
  const executable = resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const source = `${[
    "$ErrorActionPreference = 'Stop';",
    "$ProgressPreference = 'SilentlyContinue';",
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    script,
  ].join("\n")}\n`;
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    {
      encoding: "utf8",
      input: source,
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `PowerShell UI audit failed with exit code ${String(result.status)}.`,
    );
  }
  return result.stdout.trim();
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is unavailable.`);
  }
  return value;
}

function positiveInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function safeOptionalText(value, label, pattern) {
  if (!pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function parseInstalledUiAuditArguments(argv) {
  const options = {
    executablePath: null,
    identifier: DEFAULT_INSTALLED_UI_IDENTIFIER,
    expectedProcessId: null,
    expectedReleaseId: null,
    expectedVersion: null,
    minimumWidth: 640,
    minimumHeight: 480,
    maxAccessibilityElements: 2_500,
    captureScreenshot: false,
    strict: false,
  };
  const seen = new Set();
  const valueFlags = new Set([
    "--executable",
    "--identifier",
    "--expect-pid",
    "--expect-release",
    "--expect-version",
    "--minimum-width",
    "--minimum-height",
    "--max-accessibility-elements",
  ]);
  const booleanFlags = new Set(["--capture-screenshot", "--strict"]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
      throw new Error(`Unknown installed UI audit argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate installed UI audit argument: ${flag}`);
    }
    seen.add(flag);
    if (booleanFlags.has(flag)) {
      if (flag === "--capture-screenshot") options.captureScreenshot = true;
      if (flag === "--strict") options.strict = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`${flag} requires a value.`);
    }
    index += 1;
    if (flag === "--executable") options.executablePath = resolve(value);
    if (flag === "--identifier") {
      options.identifier = safeOptionalText(
        value,
        "Installed UI identifier",
        IDENTIFIER_PATTERN,
      );
    }
    if (flag === "--expect-pid") {
      options.expectedProcessId = positiveInteger(
        value,
        "--expect-pid",
        1,
        4_294_967_295,
      );
    }
    if (flag === "--expect-release") {
      options.expectedReleaseId = safeOptionalText(
        value,
        "Expected Renderer release ID",
        RELEASE_ID_PATTERN,
      );
    }
    if (flag === "--expect-version") {
      options.expectedVersion = safeOptionalText(
        value,
        "Expected Renderer version",
        VERSION_PATTERN,
      );
    }
    if (flag === "--minimum-width") {
      options.minimumWidth = positiveInteger(
        value,
        "--minimum-width",
        200,
        16_384,
      );
    }
    if (flag === "--minimum-height") {
      options.minimumHeight = positiveInteger(
        value,
        "--minimum-height",
        200,
        16_384,
      );
    }
    if (flag === "--max-accessibility-elements") {
      options.maxAccessibilityElements = positiveInteger(
        value,
        "--max-accessibility-elements",
        1,
        5_000,
      );
    }
  }
  return Object.freeze(options);
}

function windowArea(window) {
  return (window?.bounds?.width ?? 0) * (window?.bounds?.height ?? 0);
}

export function assessInstalledUiAudit(options) {
  const problems = [];
  const warnings = [];
  const observation = options.observation;
  const renderer = options.renderer;
  const process = observation?.process ?? null;
  const window = observation?.window ?? null;
  const webView = observation?.webView ?? null;
  const accessibility = observation?.accessibility ?? null;
  const screenshot = observation?.screenshot ?? null;

  if (observation?.processCount < 1 || process === null) {
    problems.push("The installed Sovereign process is not running.");
  } else {
    if (observation.processCount > 1) {
      warnings.push(
        `Multiple installed Sovereign processes are running (${observation.processCount}).`,
      );
    }
    if (
      options.expectedProcessId !== null &&
      process.processId !== options.expectedProcessId
    ) {
      problems.push(
        `Installed Sovereign PID is ${process.processId}, expected ${options.expectedProcessId}.`,
      );
    }
    if (process.responding !== true) {
      problems.push("The installed Sovereign process is not responding.");
    }
  }

  if (window === null) {
    problems.push("The installed Sovereign process has no main window.");
  } else {
    if (window.visible !== true)
      warnings.push("The Sovereign window is hidden.");
    if (window.minimized === true)
      warnings.push("The Sovereign window is minimized.");
    if (window.hung === true) problems.push("The Sovereign window is hung.");
    if (window.cloaked > 0)
      problems.push("The Sovereign window is DWM-cloaked.");
    if ((window.bounds?.width ?? 0) < options.minimumWidth) {
      problems.push(
        `Sovereign window width is ${window.bounds?.width ?? 0}, below ${options.minimumWidth}.`,
      );
    }
    if ((window.bounds?.height ?? 0) < options.minimumHeight) {
      problems.push(
        `Sovereign window height is ${window.bounds?.height ?? 0}, below ${options.minimumHeight}.`,
      );
    }
    const intersectionArea =
      (window.virtualScreenIntersection?.width ?? 0) *
      (window.virtualScreenIntersection?.height ?? 0);
    if (windowArea(window) > 0 && intersectionArea === 0) {
      problems.push("The Sovereign window is outside the virtual screen.");
    }
  }

  if (webView === null || webView.browserCount < 1) {
    problems.push("The Sovereign WebView2 browser process is missing.");
  } else {
    if (webView.rendererCount < 1) {
      problems.push("The Sovereign WebView2 renderer process is missing.");
    }
    if (webView.allUserDataPathsMatch !== true) {
      problems.push(
        "A Sovereign WebView2 process uses an unexpected data root.",
      );
    }
    if (webView.browserCount > 1) {
      warnings.push(
        `Multiple Sovereign WebView2 browser processes are present (${webView.browserCount}).`,
      );
    }
  }

  if (accessibility?.providerAvailable !== true) {
    warnings.push(
      "The installed WebView does not expose a navigable UI Automation tree.",
    );
  } else if ((accessibility.recognizedNavigation?.length ?? 0) === 0) {
    warnings.push(
      "UI Automation exposed no recognized Sovereign navigation item.",
    );
  }
  if (accessibility?.limited === true) {
    const limitStage =
      typeof accessibility.limitStage === "string" &&
      INSTALLED_UI_AUDIT_ACCESSIBILITY_LIMIT_STAGES.has(
        accessibility.limitStage,
      )
        ? accessibility.limitStage
        : null;
    const limitDiagnostic =
      typeof accessibility.diagnostic === "string" &&
      accessibility.diagnostic.trim().length > 0 &&
      accessibility.diagnostic.trim().length <= 512
        ? accessibility.diagnostic.trim()
        : null;
    const limitElapsedMs =
      Number.isSafeInteger(accessibility.elapsedMs) &&
      accessibility.elapsedMs >= 0 &&
      accessibility.elapsedMs < INSTALLED_UI_AUDIT_PARENT_TIMEOUT_MS
        ? accessibility.elapsedMs
        : null;
    if (
      limitStage === null ||
      limitDiagnostic === null ||
      limitElapsedMs === null
    ) {
      warnings.push(
        "UI Automation enumeration returned incomplete limit diagnostics.",
      );
    } else {
      warnings.push(
        `UI Automation enumeration was limited during ${limitStage}: ${limitDiagnostic}`,
      );
    }
  }
  if (accessibility?.problem) {
    warnings.push(`UI Automation probe failed: ${accessibility.problem}`);
  }

  if (renderer?.consistent !== true) {
    for (const problem of renderer?.problems ?? [
      "Installed Renderer state is unavailable.",
    ]) {
      problems.push(problem);
    }
  } else {
    const active = renderer.activeRelease;
    const builtInActive = active === null;
    if (renderer.stateJournalVerified !== true) {
      problems.push("Installed Renderer state journal was not verified.");
    }
    if (
      typeof renderer.stateSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(renderer.stateSha256) ||
      !Number.isSafeInteger(renderer.stateRevisionCount) ||
      renderer.stateRevisionCount < 1 ||
      renderer.storageRevision !== renderer.stateRevisionCount ||
      !Number.isSafeInteger(renderer.stateJournalBytes) ||
      renderer.stateJournalBytes < 1
    ) {
      problems.push("Installed Renderer state journal evidence is incomplete.");
    }
    if (!builtInActive) {
      if (renderer.readyMarkerVerified !== true) {
        problems.push("Installed Renderer ready marker was not verified.");
      }
      if (
        !Number.isSafeInteger(renderer.readyInstalledAtUnixMs) ||
        renderer.readyInstalledAtUnixMs < 1
      ) {
        problems.push(
          "Installed Renderer ready marker evidence is incomplete.",
        );
      }
      if (renderer.signatureVerified !== true) {
        problems.push("Installed Renderer signature was not verified.");
      }
      if (renderer.inventoryVerified !== true) {
        problems.push(
          "Installed Renderer component inventory was not verified.",
        );
      }
      if (renderer.entrypointMatched !== true) {
        problems.push("Installed Renderer entrypoint was not verified.");
      }
      if (
        !Number.isSafeInteger(renderer.componentCount) ||
        renderer.componentCount < 1 ||
        renderer.verifiedComponentCount !== renderer.componentCount
      ) {
        problems.push(
          "Installed Renderer component verification is incomplete.",
        );
      }
    }
    if (
      options.expectedReleaseId !== null &&
      active?.releaseId !== options.expectedReleaseId
    ) {
      problems.push(
        builtInActive
          ? `Built-in Renderer does not satisfy expected release ${options.expectedReleaseId}.`
          : `Active Renderer is ${active?.releaseId ?? "missing"}, expected ${options.expectedReleaseId}.`,
      );
    }
    if (
      options.expectedVersion !== null &&
      active?.version !== options.expectedVersion
    ) {
      problems.push(
        builtInActive
          ? `Built-in Renderer does not satisfy expected version ${options.expectedVersion}.`
          : `Active Renderer version is ${active?.version ?? "missing"}, expected ${options.expectedVersion}.`,
      );
    }
    if (renderer.pendingActivation !== null) {
      problems.push("Renderer activation is still pending.");
    }
    if (renderer.lastFailure !== null) {
      warnings.push(
        `Renderer records a previous failure: ${renderer.lastFailure}`,
      );
    }
    if (
      active !== null &&
      renderer.highestReleaseSequence !== null &&
      renderer.highestReleaseSequence > active.releaseSequence
    ) {
      warnings.push(
        `Renderer highest sequence ${renderer.highestReleaseSequence} is newer than active sequence ${active.releaseSequence}.`,
      );
    }
  }

  if (options.captureScreenshot) {
    if (screenshot?.captured !== true) {
      problems.push(
        "The requested installed-window screenshot was not captured.",
      );
    } else {
      if ((screenshot.sampledColorCount ?? 0) < 4) {
        problems.push("The installed-window screenshot appears blank.");
      }
      if ((screenshot.bytes ?? 0) < 1_024) {
        problems.push("The installed-window screenshot is unexpectedly small.");
      }
    }
  }

  return Object.freeze({
    problems: Object.freeze(problems),
    warnings: Object.freeze(warnings),
    passed: problems.length === 0 && (!options.strict || warnings.length === 0),
  });
}

function strictChild(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    relation.length > 0 &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function sameResolvedPath(left, right) {
  return (
    resolve(left).toLocaleLowerCase("en-US") ===
    resolve(right).toLocaleLowerCase("en-US")
  );
}

function sameScreenshotFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertDirectScreenshotFile(info) {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Installed UI screenshot is not a direct regular file.");
  }
  if (info.nlink !== 1n) {
    throw new Error("Installed UI screenshot may not use hard links.");
  }
  if (info.size > BigInt(MAX_INSTALLED_UI_SCREENSHOT_BYTES)) {
    throw new Error(
      `Installed UI screenshot exceeds ${MAX_INSTALLED_UI_SCREENSHOT_BYTES} bytes.`,
    );
  }
}

async function prepareScreenshotDestination(localAppData, identifier) {
  const localRoot = await realpath(localAppData);
  const identifierRoot = resolve(localRoot, identifier);
  await mkdir(identifierRoot, { recursive: true });
  const identifierReal = await realpath(identifierRoot);
  if (!strictChild(localRoot, identifierReal)) {
    throw new Error("Installed UI audit root escapes LOCALAPPDATA.");
  }
  const auditRoot = resolve(identifierReal, "ui-audit");
  await mkdir(auditRoot, { recursive: true });
  const auditReal = await realpath(auditRoot);
  if (!strictChild(identifierReal, auditReal)) {
    throw new Error("Installed UI audit output root escapes application data.");
  }

  const captureRoot = await mkdtemp(resolve(auditReal, "capture-"));
  const captureReal = await realpath(captureRoot);
  if (!strictChild(auditReal, captureReal)) {
    throw new Error("Installed UI screenshot root escapes its audit root.");
  }
  const captureInfo = await lstat(captureReal, { bigint: true });
  if (!captureInfo.isDirectory() || captureInfo.isSymbolicLink()) {
    throw new Error("Installed UI screenshot root is not a direct directory.");
  }

  const path = resolve(captureReal, "installed-ui.png");
  if (!strictChild(captureReal, path)) {
    throw new Error("Installed UI screenshot path escapes its capture root.");
  }
  const existing = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    throw new Error(
      `Installed UI screenshot destination already exists: ${path}`,
    );
  }
  return Object.freeze({ root: captureReal, path });
}

async function readVerifiedScreenshot(destination) {
  const rootReal = await realpath(destination.root);
  if (!sameResolvedPath(rootReal, destination.root)) {
    throw new Error("Installed UI screenshot root changed after allocation.");
  }
  const parentReal = await realpath(dirname(destination.path));
  if (!sameResolvedPath(parentReal, destination.root)) {
    throw new Error("Installed UI screenshot parent changed after allocation.");
  }

  const pathInfo = await lstat(destination.path, { bigint: true });
  assertDirectScreenshotFile(pathInfo);
  const pathReal = await realpath(destination.path);
  if (
    !sameResolvedPath(pathReal, destination.path) ||
    !strictChild(destination.root, pathReal)
  ) {
    throw new Error(
      "Installed UI screenshot resolves outside its allocated capture root.",
    );
  }

  const handle = await open(destination.path, "r");
  try {
    const openedInfo = await handle.stat({ bigint: true });
    assertDirectScreenshotFile(openedInfo);
    if (!sameScreenshotFileIdentity(pathInfo, openedInfo)) {
      throw new Error("Installed UI screenshot changed before it was opened.");
    }

    const bytes = await handle.readFile();
    const completedInfo = await handle.stat({ bigint: true });
    if (!sameScreenshotFileIdentity(openedInfo, completedInfo)) {
      throw new Error("Installed UI screenshot changed while it was read.");
    }
    const currentPathInfo = await lstat(destination.path, { bigint: true });
    if (!sameScreenshotFileIdentity(openedInfo, currentPathInfo)) {
      throw new Error(
        "Installed UI screenshot path changed while it was read.",
      );
    }
    const parentAfterRead = await realpath(dirname(destination.path));
    if (!sameResolvedPath(parentAfterRead, destination.root)) {
      throw new Error(
        "Installed UI screenshot parent changed while it was read.",
      );
    }

    return Object.freeze({
      bytes: Number(openedInfo.size),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

export async function runInstalledUiAudit(options, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("Installed UI audit is Windows-only.");
  }
  const localAppData = requiredEnvironment(environment, "LOCALAPPDATA");
  const appData = requiredEnvironment(environment, "APPDATA");
  const executablePath =
    options.executablePath ??
    resolve(
      localAppData,
      "Programs",
      DEFAULT_INSTALLED_UI_PRODUCT_NAME,
      "sovereign-desktop-tauri.exe",
    );
  const expectedWebViewDataPath = resolve(
    localAppData,
    options.identifier,
    "EBWebView",
  );
  const screenshotDestination = options.captureScreenshot
    ? await prepareScreenshotDestination(localAppData, options.identifier)
    : null;
  const powershell = buildInstalledUiAuditPowerShell({
    executablePath,
    expectedWebViewDataPath,
    screenshotPath: screenshotDestination?.path ?? null,
    maxAccessibilityElements: options.maxAccessibilityElements,
    accessibilityDeadlineMs: INSTALLED_UI_AUDIT_ACCESSIBILITY_DEADLINE_MS,
  });
  const powershellRunner = dependencies.runPowerShell ?? runPowerShellFromStdin;
  const output = powershellRunner(
    powershell,
    INSTALLED_UI_AUDIT_PARENT_TIMEOUT_MS,
  );
  const observation = JSON.parse(output);
  if (observation?.screenshot?.captured === true) {
    if (screenshotDestination === null) {
      throw new Error(
        "Installed UI audit returned screenshot evidence without a capture request.",
      );
    }
    const observedPath = observation.screenshot.path;
    if (
      typeof observedPath !== "string" ||
      !sameResolvedPath(observedPath, screenshotDestination.path)
    ) {
      throw new Error(
        "Installed UI screenshot path does not match the allocated destination.",
      );
    }
    const screenshotEvidence = await readVerifiedScreenshot(
      screenshotDestination,
    );
    observation.screenshot.path = screenshotDestination.path;
    observation.screenshot.bytes = screenshotEvidence.bytes;
    observation.screenshot.sha256 = screenshotEvidence.sha256;
  }
  const rendererReader =
    dependencies.readRendererState ?? readInstalledRendererState;
  const renderer = await rendererReader({
    appDataPath: appData,
    identifier: options.identifier,
    trustedKeysPath: resolve(
      dirname(executablePath),
      "renderer-trusted-keys.json",
    ),
  });
  const assessment = assessInstalledUiAudit({
    ...options,
    observation,
    renderer,
  });
  return Object.freeze({
    schemaVersion: INSTALLED_UI_AUDIT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    strict: options.strict,
    passed: assessment.passed,
    executablePath,
    process: observation.process ?? null,
    processCount: observation.processCount ?? 0,
    window: observation.window ?? null,
    webView: observation.webView ?? null,
    accessibility: observation.accessibility ?? null,
    renderer,
    screenshot: observation.screenshot ?? null,
    problems: assessment.problems,
    warnings: assessment.warnings,
  });
}

export async function runInstalledUiAuditCli(argv) {
  const result = await runInstalledUiAudit(
    parseInstalledUiAuditArguments(argv),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
  return result;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runInstalledUiAuditCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Installed UI audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
