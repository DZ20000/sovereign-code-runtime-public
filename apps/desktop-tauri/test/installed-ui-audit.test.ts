import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessInstalledUiAudit,
  DEFAULT_INSTALLED_UI_IDENTIFIER,
  DEFAULT_INSTALLED_UI_PRODUCT_NAME,
  MAX_INSTALLED_UI_SCREENSHOT_BYTES,
  parseInstalledUiAuditArguments,
  runInstalledUiAudit,
  type InstalledUiAuditOptions,
} from "../scripts/installed-ui-audit.mjs";

function options(
  overrides: Partial<InstalledUiAuditOptions> = {},
): InstalledUiAuditOptions {
  return {
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
    ...overrides,
  };
}

function healthyObservation() {
  return {
    processCount: 1,
    process: {
      processId: 42,
      parentProcessId: 1,
      executablePath:
        "C:\\Users\\Test\\AppData\\Local\\Programs\\Sovereign Code Runtime\\sovereign-desktop-tauri.exe",
      creationTime: "2026-08-29T00:00:00.000Z",
      responding: true,
    },
    window: {
      handle: "0x1234",
      title: "Sovereign",
      visible: true,
      minimized: false,
      hung: false,
      cloaked: 0,
      foreground: false,
      bounds: { left: 0, top: 0, width: 1_200, height: 800 },
      virtualScreenIntersection: { width: 1_200, height: 800 },
    },
    webView: {
      processCount: 5,
      browserCount: 1,
      rendererCount: 1,
      gpuCount: 1,
      networkServiceCount: 1,
      allUserDataPathsMatch: true,
      versions: ["151.0.4129.107"],
      roles: [],
    },
    accessibility: {
      elementCount: 25,
      limited: false,
      limitStage: null as string | null,
      diagnostic: null as string | null,
      elapsedMs: 0,
      recognizedNavigation: ["Tasks"],
      providerAvailable: true,
      problem: null,
    },
    screenshot: null as null | {
      requested: boolean;
      captured: boolean;
      path: string;
      width: number;
      height: number;
      sampledColorCount: number;
      bytes: number;
    },
  };
}

function healthyRenderer() {
  const release = {
    releaseId: "renderer-42",
    releaseSequence: 42,
    version: "0.1.10",
    channel: "development",
    manifestSha256: "a".repeat(64),
  };
  return {
    available: true,
    consistent: true,
    stateFile: "revision-00000000000000000042.json",
    stateSha256: "c".repeat(64),
    stateJournalVerified: true,
    stateRevisionCount: 42,
    stateJournalBytes: 4_096,
    storageRevision: 42,
    updatedAtUnixMs: 1_787_000_000_000,
    activeRelease: release,
    readyRelease: release,
    readyMarkerVerified: true,
    readyInstalledAtUnixMs: 1_787_000_000_000,
    envelopeRelease: release,
    highestReleaseSequence: 42,
    pendingActivation: null,
    lastFailure: null,
    lastKnownGoodRelease: null,
    entrypoint: "index.html",
    entrypointMatched: true,
    trustedKeysPath:
      "C:\\Users\\Test\\AppData\\Local\\Programs\\Sovereign Code Runtime\\renderer-trusted-keys.json",
    signingKeyId: "renderer-key-1",
    signatureVerified: true,
    inventoryVerified: true,
    componentCount: 3,
    verifiedComponentCount: 3,
    problems: [],
  };
}

function healthyBuiltInRenderer() {
  return {
    ...healthyRenderer(),
    stateFile: "revision-00000000000000000001.json",
    stateSha256: "b".repeat(64),
    stateRevisionCount: 1,
    stateJournalBytes: 256,
    storageRevision: 1,
    activeRelease: null,
    readyRelease: null,
    readyMarkerVerified: false,
    readyInstalledAtUnixMs: null,
    envelopeRelease: null,
    highestReleaseSequence: 0,
    lastKnownGoodRelease: null,
    entrypoint: null,
    entrypointMatched: false,
    signingKeyId: null,
    signatureVerified: false,
    inventoryVerified: false,
    componentCount: 0,
    verifiedComponentCount: 0,
  };
}

function screenshotPathFromScript(script: string): string {
  const match = script.match(/^\$screenshotPath = '((?:[^']|'')*)'$/mu);
  if (match?.[1] === undefined) {
    throw new Error("The audit script did not contain a screenshot path.");
  }
  return match[1].replace(/''/gu, "'");
}

async function runScreenshotAudit(
  root: string,
  writeEvidence: (expectedPath: string) => void,
  observedPathFor: (expectedPath: string) => string = (path) => path,
) {
  const localAppData = join(root, "Local");
  const appData = join(root, "Roaming");
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(appData, { recursive: true });
  const executablePath = resolve(
    localAppData,
    "Programs",
    DEFAULT_INSTALLED_UI_PRODUCT_NAME,
    "sovereign-desktop-tauri.exe",
  );
  const observation = healthyObservation();
  observation.process.executablePath = executablePath;

  return await runInstalledUiAudit(
    options({ captureScreenshot: true, executablePath }),
    {
      platform: "win32",
      environment: { LOCALAPPDATA: localAppData, APPDATA: appData },
      runPowerShell: (script) => {
        const expectedPath = screenshotPathFromScript(script);
        writeEvidence(expectedPath);
        observation.screenshot = {
          requested: true,
          captured: true,
          path: observedPathFor(expectedPath),
          width: 1_200,
          height: 800,
          sampledColorCount: 12,
          bytes: 0,
        };
        return JSON.stringify(observation);
      },
      readRendererState: async () => healthyRenderer(),
    },
  );
}

describe("installed UI audit", () => {
  it("parses bounded release, PID, viewport and screenshot expectations", () => {
    expect(
      parseInstalledUiAuditArguments([
        "--strict",
        "--capture-screenshot",
        "--expect-pid",
        "42",
        "--expect-release",
        "renderer-42",
        "--expect-version",
        "0.1.10",
        "--minimum-width",
        "800",
        "--minimum-height",
        "600",
        "--max-accessibility-elements",
        "1000",
      ]),
    ).toMatchObject({
      strict: true,
      captureScreenshot: true,
      expectedProcessId: 42,
      expectedReleaseId: "renderer-42",
      expectedVersion: "0.1.10",
      minimumWidth: 800,
      minimumHeight: 600,
      maxAccessibilityElements: 1_000,
    });
  });

  it("rejects duplicate, malformed and unsafe arguments", () => {
    expect(() =>
      parseInstalledUiAuditArguments(["--strict", "--strict"]),
    ).toThrow("Duplicate");
    expect(() => parseInstalledUiAuditArguments(["--expect-pid", "0"])).toThrow(
      "from 1",
    );
    expect(() =>
      parseInstalledUiAuditArguments(["--expect-release", "../escape"]),
    ).toThrow("invalid");
    expect(() =>
      parseInstalledUiAuditArguments(["--identifier", "bad/path"]),
    ).toThrow("invalid");
    expect(() => parseInstalledUiAuditArguments(["--unknown"])).toThrow(
      "Unknown",
    );
  });

  it("passes a healthy installed process, window, WebView and Renderer", () => {
    const assessment = assessInstalledUiAudit({
      ...options({
        expectedProcessId: 42,
        expectedReleaseId: "renderer-42",
        expectedVersion: "0.1.10",
      }),
      observation: healthyObservation(),
      renderer: healthyRenderer(),
    });
    expect(assessment).toEqual({ problems: [], warnings: [], passed: true });
  });

  it("accepts a verified built-in Renderer and rejects explicit custom expectations", () => {
    const renderer = healthyBuiltInRenderer();
    const assessment = assessInstalledUiAudit({
      ...options(),
      observation: healthyObservation(),
      renderer,
    });
    expect(assessment).toEqual({ problems: [], warnings: [], passed: true });

    const expectedCustomRelease = assessInstalledUiAudit({
      ...options({
        expectedReleaseId: "renderer-42",
        expectedVersion: "0.1.10",
      }),
      observation: healthyObservation(),
      renderer,
    });
    expect(expectedCustomRelease.passed).toBe(false);
    expect(expectedCustomRelease.problems).toEqual([
      "Built-in Renderer does not satisfy expected release renderer-42.",
      "Built-in Renderer does not satisfy expected version 0.1.10.",
    ]);
  });

  it("fails closed when Renderer signature or component evidence is incomplete", () => {
    const renderer = {
      ...healthyRenderer(),
      stateJournalVerified: false,
      stateSha256: null,
      stateRevisionCount: 41,
      stateJournalBytes: 0,
      readyMarkerVerified: false,
      readyInstalledAtUnixMs: null,
      signatureVerified: false,
      inventoryVerified: false,
      entrypointMatched: false,
      verifiedComponentCount: 1,
    };
    const assessment = assessInstalledUiAudit({
      ...options(),
      observation: healthyObservation(),
      renderer,
    });
    expect(assessment.passed).toBe(false);
    expect(assessment.problems).toEqual(
      expect.arrayContaining([
        "Installed Renderer state journal was not verified.",
        "Installed Renderer state journal evidence is incomplete.",
        "Installed Renderer ready marker was not verified.",
        "Installed Renderer ready marker evidence is incomplete.",
        "Installed Renderer signature was not verified.",
        "Installed Renderer component inventory was not verified.",
        "Installed Renderer entrypoint was not verified.",
        "Installed Renderer component verification is incomplete.",
      ]),
    );
  });

  it("keeps missing accessibility and historical Renderer failure visible", () => {
    const observation = healthyObservation();
    observation.window.visible = false;
    observation.accessibility = {
      elementCount: 2,
      limited: false,
      limitStage: null,
      diagnostic: null,
      elapsedMs: 0,
      recognizedNavigation: [],
      providerAvailable: false,
      problem: null,
    };
    const renderer = {
      ...healthyRenderer(),
      highestReleaseSequence: 50,
      lastFailure: "A newer activation rolled back.",
    };
    const normal = assessInstalledUiAudit({
      ...options(),
      observation,
      renderer,
    });
    expect(normal.problems).toEqual([]);
    expect(normal.warnings).toHaveLength(4);
    expect(normal.warnings).toContain("The Sovereign window is hidden.");
    expect(normal.passed).toBe(true);
    expect(
      assessInstalledUiAudit({
        ...options({ strict: true }),
        observation,
        renderer,
      }).passed,
    ).toBe(false);
  });

  it("preserves bounded UI Automation deadline evidence and makes strict mode fail", () => {
    const observation = healthyObservation();
    observation.accessibility = {
      elementCount: 18,
      limited: true,
      limitStage: "process-descendants",
      diagnostic:
        "UI Automation process-descendants exceeded the internal 20000 ms deadline.",
      elapsedMs: 20_000,
      recognizedNavigation: ["Tasks"],
      providerAvailable: true,
      problem: null,
    };
    const expectedWarning =
      "UI Automation enumeration was limited during process-descendants: UI Automation process-descendants exceeded the internal 20000 ms deadline.";

    const normal = assessInstalledUiAudit({
      ...options(),
      observation,
      renderer: healthyRenderer(),
    });
    expect(normal).toEqual({
      problems: [],
      warnings: [expectedWarning],
      passed: true,
    });

    const strict = assessInstalledUiAudit({
      ...options({ strict: true }),
      observation,
      renderer: healthyRenderer(),
    });
    expect(strict).toEqual({
      problems: [],
      warnings: [expectedWarning],
      passed: false,
    });
  });

  it("reports incomplete UI Automation limit diagnostics without losing machine evidence", () => {
    const observation = healthyObservation();
    observation.accessibility = {
      ...observation.accessibility,
      limited: true,
      limitStage: null,
      diagnostic: null,
      elapsedMs: 20_000,
    };
    const assessment = assessInstalledUiAudit({
      ...options({ strict: true }),
      observation,
      renderer: healthyRenderer(),
    });
    expect(assessment.problems).toEqual([]);
    expect(assessment.warnings).toContain(
      "UI Automation enumeration returned incomplete limit diagnostics.",
    );
    expect(assessment.passed).toBe(false);
  });

  it("fails closed on process, window, WebView, Renderer and screenshot drift", () => {
    const observation = healthyObservation();
    observation.process.responding = false;
    observation.window.bounds.width = 320;
    observation.window.virtualScreenIntersection.width = 0;
    observation.window.virtualScreenIntersection.height = 0;
    observation.webView.rendererCount = 0;
    observation.webView.allUserDataPathsMatch = false;
    observation.screenshot = {
      requested: true,
      captured: true,
      path: "C:\\audit\\blank.png",
      width: 320,
      height: 800,
      sampledColorCount: 1,
      bytes: 64,
    };
    const assessment = assessInstalledUiAudit({
      ...options({
        captureScreenshot: true,
        expectedProcessId: 99,
        expectedReleaseId: "other",
      }),
      observation,
      renderer: {
        ...healthyRenderer(),
        pendingActivation: { releaseId: "next" },
      },
    });
    expect(assessment.passed).toBe(false);
    expect(assessment.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected 99"),
        expect.stringContaining("not responding"),
        expect.stringContaining("width"),
        expect.stringContaining("outside the virtual screen"),
        expect.stringContaining("renderer process is missing"),
        expect.stringContaining("unexpected data root"),
        expect.stringContaining("expected other"),
        expect.stringContaining("still pending"),
        expect.stringContaining("appears blank"),
        expect.stringContaining("unexpectedly small"),
      ]),
    );
  });

  it("hashes only the direct file at the allocated screenshot destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "scr-installed-ui-evidence-"));
    try {
      const result = await runScreenshotAudit(root, (expectedPath) => {
        writeFileSync(expectedPath, Buffer.alloc(2_048, 0x5a));
      });

      expect(result.passed).toBe(true);
      expect(result.screenshot.bytes).toBe(2_048);
      expect(result.screenshot.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.screenshot.path).toContain("ui-audit");
      expect(result.screenshot.path).toContain("capture-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a screenshot path that differs from the allocated destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "scr-installed-ui-path-"));
    try {
      await expect(
        runScreenshotAudit(
          root,
          () => undefined,
          () => join(root, "outside.png"),
        ),
      ).rejects.toThrow("does not match the allocated destination");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects hard-linked screenshot evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "scr-installed-ui-link-"));
    const source = join(root, "source.png");
    writeFileSync(source, Buffer.alloc(2_048, 0x33));
    try {
      await expect(
        runScreenshotAudit(root, (expectedPath) => {
          linkSync(source, expectedPath);
        }),
      ).rejects.toThrow("may not use hard links");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects screenshot evidence above the bounded byte ceiling", async () => {
    const root = mkdtempSync(join(tmpdir(), "scr-installed-ui-size-"));
    try {
      await expect(
        runScreenshotAudit(root, (expectedPath) => {
          writeFileSync(expectedPath, Buffer.alloc(1));
          truncateSync(expectedPath, MAX_INSTALLED_UI_SCREENSHOT_BYTES + 1);
        }),
      ).rejects.toThrow(`exceeds ${MAX_INSTALLED_UI_SCREENSHOT_BYTES} bytes`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("composes a built-in Renderer through the read-only runtime audit", async () => {
    const observation = healthyObservation();
    const dependencies = {
      platform: "win32" as const,
      environment: {
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
      },
      runPowerShell: () => JSON.stringify(observation),
      readRendererState: async () => healthyBuiltInRenderer(),
    };

    const result = await runInstalledUiAudit(options(), dependencies);
    expect(result.passed).toBe(true);
    expect(result.renderer.activeRelease).toBeNull();
    expect(result.problems).toEqual([]);

    const expectedCustom = await runInstalledUiAudit(
      options({
        expectedReleaseId: "renderer-42",
        expectedVersion: "0.1.10",
      }),
      dependencies,
    );
    expect(expectedCustom.passed).toBe(false);
    expect(expectedCustom.problems).toEqual([
      "Built-in Renderer does not satisfy expected release renderer-42.",
      "Built-in Renderer does not satisfy expected version 0.1.10.",
    ]);
  });

  it("supports a dependency-injected read-only runtime probe", async () => {
    let observedScript = "";
    let observedTimeoutMs: number | undefined;
    let rendererOptions: {
      readonly appDataPath: string;
      readonly identifier: string;
      readonly trustedKeysPath: string;
    } | null = null;
    const observation = healthyObservation();
    const result = await runInstalledUiAudit(options(), {
      platform: "win32",
      environment: {
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
      },
      runPowerShell: (script, timeoutMs) => {
        observedScript = script;
        observedTimeoutMs = timeoutMs;
        return JSON.stringify(observation);
      },
      readRendererState: async (value) => {
        rendererOptions = value;
        return healthyRenderer();
      },
    });

    expect(result.passed).toBe(true);
    expect(result.process.processId).toBe(42);
    expect(rendererOptions).toEqual({
      appDataPath: "C:\\Users\\Test\\AppData\\Roaming",
      identifier: DEFAULT_INSTALLED_UI_IDENTIFIER,
      trustedKeysPath:
        "C:\\Users\\Test\\AppData\\Local\\Programs\\Sovereign Code Runtime\\renderer-trusted-keys.json",
    });
    expect(observedTimeoutMs).toBe(30_000);
    expect(observedScript).toContain("$maxAccessibilityElements = 2500");
    expect(observedScript).toContain("$accessibilityDeadlineMs = 20000");
    expect(observedScript).toContain("AsyncWaitHandle.WaitOne");
    expect(observedScript).toContain("BeginStop");
    expect(observedScript).toContain("limitStage");
    expect(observedScript).toContain("diagnostic");
    expect(observedScript).toContain("elapsedMs");
    expect(observedScript).toContain("Get-CimInstance Win32_Process");
    expect(observedScript).toContain("IsHungAppWindow");
    expect(observedScript).toContain("UIAutomationClient");
    expect(observedScript).not.toContain("Start-Process");
    expect(observedScript).not.toContain("SetForegroundWindow");
    expect(observedScript).not.toContain("InvokePattern");
  });
  it.runIf(process.platform === "win32")(
    "returns generated deadline-limited UI Automation evidence before 12 seconds",
    async () => {
      const root = mkdtempSync(
        join(tmpdir(), "scr-installed-ui-uia-deadline-"),
      );
      const executablePath = join(root, "synthetic.exe");
      const appDataPath = join(root, "AppData", "Roaming");
      const localAppDataPath = join(root, "AppData", "Local");
      const probePath = join(root, "probe.ps1");
      let elapsedMs = 0;
      try {
        mkdirSync(appDataPath, { recursive: true });
        mkdirSync(localAppDataPath, { recursive: true });
        writeFileSync(executablePath, "fixture\n", "utf8");

        const result = await runInstalledUiAudit(options({ executablePath }), {
          platform: "win32",
          environment: {
            APPDATA: appDataPath,
            LOCALAPPDATA: localAppDataPath,
          },
          runPowerShell(script, timeoutMs) {
            expect(timeoutMs).toBe(30_000);
            expect(script).toContain("$maxAccessibilityElements = 2500");
            expect(script).toContain("$accessibilityDeadlineMs = 20000");
            const accessibilityStart = script.indexOf("$recognizedNames = @(");
            const screenshotStart = script.indexOf(
              "$screenshot = $null",
              accessibilityStart,
            );
            expect(accessibilityStart).toBeGreaterThanOrEqual(0);
            expect(screenshotStart).toBeGreaterThan(accessibilityStart);

            let probe = [
              "$maxAccessibilityElements = 2500",
              "$accessibilityDeadlineMs = 1000",
              "$probeStopwatch = [Diagnostics.Stopwatch]::StartNew()",
              "function Get-BoundedAuditText([object]$value) {",
              "  $text = [string]$value",
              "  if ($text.Length -le 512) { return $text }",
              "  return $text.Substring(0, 512)",
              "}",
              "$selected = [pscustomobject]@{ ProcessId = [int]$PID }",
              "$webViewRows = @()",
              script.slice(accessibilityStart, screenshotStart),
              "[pscustomobject]@{ accessibility = $accessibility } | ConvertTo-Json -Depth 8 -Compress",
            ].join("\n");
            probe = probe.replace(
              "stage = 'accessibility-bootstrap'",
              "stage = 'automation-root'",
            );
            const delayMarker =
              "try {\n  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop";
            expect(probe).toContain(delayMarker);
            probe = probe.replace(
              delayMarker,
              "try {\n  Start-Sleep -Seconds 10\n  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop",
            );
            writeFileSync(
              probePath,
              `\ufeff$ErrorActionPreference = 'Stop'\r\n$ProgressPreference = 'SilentlyContinue'\r\n$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n${probe}\r\n`,
              "utf8",
            );

            const startedAt = Date.now();
            const execution = spawnSync(
              resolve(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe",
              ),
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                probePath,
              ],
              {
                encoding: "utf8",
                maxBuffer: 4 * 1024 * 1024,
                timeout: 12_000,
                windowsHide: true,
              },
            );
            elapsedMs = Date.now() - startedAt;
            if (execution.error !== undefined) throw execution.error;
            if (execution.status !== 0) {
              throw new Error(
                `Generated PowerShell exited ${execution.status}: ${execution.stderr}`,
              );
            }
            return execution.stdout;
          },
          readRendererState: async () => healthyBuiltInRenderer(),
        });

        expect(elapsedMs).toBeLessThan(12_000);
        expect(result.accessibility).toMatchObject({
          elementCount: 0,
          limited: true,
          limitStage: "automation-root",
          diagnostic: expect.stringContaining("automation-root"),
          recognizedNavigation: [],
          providerAvailable: false,
          problem: null,
        });
        expect(result.warnings).toContainEqual(
          expect.stringContaining(
            "UI Automation enumeration was limited during automation-root",
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
