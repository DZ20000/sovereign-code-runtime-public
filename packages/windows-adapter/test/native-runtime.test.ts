import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import { WindowsAdapter } from "../src/index.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const nativeAgentPath = resolve(
  currentDirectory,
  "../../../apps/desktop/native/bin/SovereignNativeAgent.exe",
);
const cleanupPaths: string[] = [];
const owner = createPrincipal("native-test-owner", CAPABILITIES, ["workspace"]);

async function createAdapter(): Promise<WindowsAdapter> {
  const root = await mkdtemp(join(tmpdir(), "scr-native-runtime-"));
  cleanupPaths.push(root);
  return new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy: new PolicyEngine(),
    audit: new MemoryAuditStore(),
    nativeAgentPath,
  });
}

async function createBrowserFixture(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  let port = 0;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <html>
          <head><title>Browser control fixture</title></head>
          <body>
            <label>Query <input aria-label="Query" /></label>
            <label>Password <input aria-label="Account password" type="password" /></label>
            <button onclick="document.getElementById('result').textContent = document.querySelector('[aria-label=Query]').value">Apply</button>
            <div id="result">waiting</div>
            <img alt="blocked resource" src="http://localhost:${port}/blocked.png" />
          </body>
        </html>`);
      return;
    }
    response.statusCode = 204;
    response.end();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("Browser fixture did not receive a TCP port."));
        return;
      }
      port = address.port;
      resolveListen();
    });
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    ),
  );
});

const nativeIt = process.platform === "win32" && existsSync(nativeAgentPath) ? it : it.skip;

describe("native Windows runtime slices", () => {
  nativeIt("matches the x64 Win32 INPUT layout without injecting input", () => {
    const script = `
$assembly = [Reflection.Assembly]::LoadFile('${nativeAgentPath.replaceAll("'", "''")}')
$agent = $assembly.GetType('SovereignNativeAgent', $true)
$inputType = $agent.GetNestedType('INPUT', [Reflection.BindingFlags]::NonPublic)
$unionType = $agent.GetNestedType('INPUTUNION', [Reflection.BindingFlags]::NonPublic)
[pscustomobject]@{
  pointerBytes = [IntPtr]::Size
  inputBytes = [Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($inputType))
  unionBytes = [Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($unionType))
  unionOffset = [Runtime.InteropServices.Marshal]::OffsetOf($inputType, 'U').ToInt64()
  keyboardOffset = [Runtime.InteropServices.Marshal]::OffsetOf($unionType, 'ki').ToInt64()
} | ConvertTo-Json -Compress
`;
    const checked = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(checked.error).toBeUndefined();
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout.trim())).toEqual({
      pointerBytes: 8, inputBytes: 40, unionBytes: 32, unionOffset: 8, keyboardOffset: 0,
    });
  });

  nativeIt("creates an interactive ConPTY, submits input, and closes it", async () => {
    const adapter = await createAdapter();
    try {
      const created = await adapter.createTerminalSession(owner, "workspace", "", 100, 28);
      expect(created.state).toMatch(/starting|running/u);

      await adapter.writeTerminalSession(
        owner,
        "workspace",
        created.id,
        "echo conpty-ready",
        true,
      );

      let snapshot = adapter.getTerminalSession(owner, "workspace", created.id);
      const deadline = Date.now() + 8_000;
      while (!snapshot.output.includes("conpty-ready") && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        snapshot = adapter.getTerminalSession(owner, "workspace", created.id);
      }
      expect(snapshot.output).toContain("conpty-ready");

      const closed = await adapter.closeTerminalSession(owner, "workspace", created.id);
      expect(["closed", "exited"]).toContain(closed.state);
    } finally {
      await adapter.shutdown();
    }
  }, 20_000);

  nativeIt("controls managed Edge with revision-bound refs, observes Windows, and runs a workflow", async () => {
    const adapter = await createAdapter();
    const fixture = await createBrowserFixture();
    let browserId: string | null = null;
    try {
      const browserCapabilities = adapter.browserCapabilities(owner);
      expect(browserCapabilities).toMatchObject({
        available: true,
        requestInterception: true,
        semanticElementRefs: true,
      });
      const browser = await adapter.createBrowserSession(owner, "workspace", ["127.0.0.1"]);
      browserId = browser.id;
      expect(browser.state).toBe("ready");

      const observed = await adapter.navigateBrowser(
        owner,
        "workspace",
        browser.id,
        fixture.url,
      );
      expect(observed.revision).toMatch(/^[a-f0-9]{64}$/u);
      expect(observed.blockedRequestCount).toBeGreaterThan(0);
      const query = observed.elements.find(
        (element) => element.role === "textbox" && element.name === "Query",
      );
      const password = observed.elements.find((element) => element.sensitive);
      const apply = observed.elements.find(
        (element) => element.role === "button" && element.name === "Apply",
      );
      expect(query).toBeDefined();
      expect(password).toBeDefined();
      expect(apply).toBeDefined();
      if (query === undefined || password === undefined || apply === undefined) {
        throw new Error("Managed browser fixture did not expose the expected semantic refs.");
      }

      const typed = await adapter.typeBrowser(
        owner,
        "workspace",
        browser.id,
        observed.revision,
        query.ref,
        "browser-ready",
        true,
        false,
      );
      await expect(
        adapter.clickBrowser(owner, "workspace", browser.id, observed.revision, apply.ref),
      ).rejects.toMatchObject({ code: "STALE_HASH" });
      await expect(
        adapter.typeBrowser(
          owner,
          "workspace",
          browser.id,
          typed.revision,
          password.ref,
          "not-entered",
          true,
          false,
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const clicked = await adapter.clickBrowser(
        owner,
        "workspace",
        browser.id,
        typed.revision,
        apply.ref,
      );
      expect(clicked.text).toContain("browser-ready");

      const computerCapabilities = adapter.computerCapabilities(owner);
      expect(computerCapabilities.available).toBe(true);
      const desktop = await adapter.observeComputer(owner, "workspace", false);
      expect(desktop.revision).toMatch(/^[a-f0-9]{64}$/u);
      expect(desktop.virtualScreen.width).toBeGreaterThan(0);

      const pythonCapabilities = await adapter.pythonCapabilities(owner, "workspace");
      const steps = pythonCapabilities.available
        ? [{ kind: "python" as const, code: "print('workflow-ready')" }]
        : [{ kind: "terminal" as const, command: "Write-Output 'workflow-ready'" }];
      const run = await adapter.startWorkflowRun(
        owner,
        "workspace",
        "Native runtime smoke",
        steps,
        "",
        30_000,
      );
      const completed = await adapter.waitRun(owner, "workspace", run.id, 25_000);
      expect(completed).toMatchObject({ kind: "workflow", state: "succeeded", exitCode: 0 });
      expect(completed.stdout).toContain("workflow-ready");
    } finally {
      if (browserId !== null) {
        await adapter.closeBrowserSession(owner, "workspace", browserId).catch(() => undefined);
      }
      await Promise.allSettled([adapter.shutdown(), fixture.close()]);
    }
  }, 60_000);
});
