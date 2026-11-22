import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const schema = z.object({ schemaVersion: z.literal("scr.connection/v1"), name: z.literal("sovereign-code-runtime"),
  transport: z.object({ type: z.literal("streamable-http"), url: z.string().url().max(2048),
    headers: z.object({ Authorization: z.string().max(8192).regex(/^Bearer [^\s]{16,}$/u) }) }) });

export function parseGeminiLocalConnection(value: unknown) {
  const connection = schema.parse(value);
  const url = new URL(connection.transport.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" ||
      url.username || url.password || url.search || url.hash) throw new Error("Expected the local Sovereign MCP connection.");
  return connection;
}

function pairingPath(environment: NodeJS.ProcessEnv) {
  return environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, "Sovereign Code Runtime", "gemini", "sovereign-local-connection.dpapi") : null;
}

const codec = Buffer.from(`
$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('SCR_DPAPI_STAGE:started')
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$inputText=[Console]::In.ReadToEnd()
[Console]::Error.WriteLine('SCR_DPAPI_STAGE:read')
# Use only the built-in modules; hosted machines can have a large third-party inventory.
$PSModuleAutoLoadingPreference='None'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
Import-Module ([IO.Path]::Combine($env:PSModulePath,'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'))
Import-Module ([IO.Path]::Combine($env:PSModulePath,'Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1'))
$inputValue=$inputText|ConvertFrom-Json
[Console]::Error.WriteLine('SCR_DPAPI_STAGE:parsed')
if($inputValue.mode -eq 'protect'){
  $result=ConvertTo-SecureString $inputValue.value -AsPlainText -Force|ConvertFrom-SecureString
}else{
  $result=[Net.NetworkCredential]::new('',(ConvertTo-SecureString $inputValue.value)).Password
}
[Console]::Error.WriteLine('SCR_DPAPI_STAGE:transformed')
[Console]::Out.Write($result)
[Console]::Error.WriteLine('SCR_DPAPI_STAGE:written')
`, "utf16le").toString("base64");

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Local Gemini connection update was cancelled.");
}

function transformSecret(mode: "protect" | "restore", value: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const executable = join(environment.SystemRoot ?? environment.WINDIR ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]
      .flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]));
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", codec], {
      shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let diagnosticTail = "";
    let discardDiagnosticLine = false;
    let stage = "spawn";
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* Preserve the bounded, credential-free failure. */ }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error("Local Gemini connection " + mode + " failed (" + reason + "; stage " + stage + ")."));
    };
    const onAbort = () => fail("cancelled");
    const deadline = setTimeout(() => fail("timed out after 20000 ms"), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > 512 * 1024) return fail("output exceeded the protection limit");
      output += chunk;
    });
    // Only fixed markers are retained. PowerShell errors can include credential input.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      const parts = chunk.split("\n");
      for (let index = 0; index < parts.length; index++) {
        const complete = index < parts.length - 1;
        if (!discardDiagnosticLine) {
          const line = diagnosticTail + parts[index]!;
          if (complete) {
            const match = /^SCR_DPAPI_STAGE:(started|read|parsed|transformed|written)\r?$/u.exec(line);
            if (match) stage = match[1]!;
          } else if (["started", "read", "parsed", "transformed", "written"]
            .some((value) => ("SCR_DPAPI_STAGE:" + value + "\r").startsWith(line))) {
            diagnosticTail = line;
          } else {
            diagnosticTail = "";
            discardDiagnosticLine = true;
          }
        }
        if (complete) { diagnosticTail = ""; discardDiagnosticLine = false; }
      }
    });
    child.on("error", () => fail("process could not start"));
    child.stdin.once("error", () => fail("input pipe failed"));
    child.stdout.once("error", () => fail("output pipe failed"));
    child.stderr.once("error", () => fail("diagnostic pipe failed"));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0 || !output.trim()) return fail("exit " + String(code));
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      resolve(output.trim());
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    child.stdin.end(JSON.stringify({ mode, value }));
  });
}

export async function readRegisteredGeminiConnection(environment = process.env, signal?: AbortSignal) {
  assertNotAborted(signal);
  const path = pairingPath(environment);
  if (process.platform !== "win32" || !path) return null;
  let protectedValue: string;
  try { protectedValue = await readFile(path, { encoding: "utf8", ...(signal ? { signal } : {}) }); }
  catch (error) { assertNotAborted(signal); if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const restored = await transformSecret("restore", protectedValue.trim(), environment, signal);
  assertNotAborted(signal);
  return parseGeminiLocalConnection(JSON.parse(restored));
}

/** Register a connection explicitly; credentials remain protected by the current Windows account. */
export async function registerGeminiLocalConnection(value: unknown, environment = process.env, signal?: AbortSignal) {
  assertNotAborted(signal);
  const connection = parseGeminiLocalConnection(value);
  const path = pairingPath(environment);
  if (process.platform !== "win32" || !path) throw new Error("Protected Gemini pairing requires Windows LOCALAPPDATA.");
  const protectedValue = await transformSecret("protect", JSON.stringify(connection), environment, signal);
  assertNotAborted(signal);
  await mkdir(dirname(path), { recursive: true });
  assertNotAborted(signal);
  const temporary = join(dirname(path), `.gemini-connection-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, protectedValue, { encoding: "ascii", flag: "wx", ...(signal ? { signal } : {}) });
    assertNotAborted(signal);
    await rename(temporary, path);
  }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  return connection;
}

/** An owner-initiated Gateway update may refresh only an existing local pairing. */
export async function refreshRegisteredGeminiConnection(endpoint: string, bearerToken: string, environment = process.env, signal?: AbortSignal) {
  const previous = await readRegisteredGeminiConnection(environment, signal);
  if (!previous) return false;
  const connection = parseGeminiLocalConnection({ ...previous, transport: { ...previous.transport, url: endpoint,
    headers: { Authorization: `Bearer ${bearerToken}` } } });
  if (JSON.stringify(previous) === JSON.stringify(connection)) return false;
  await registerGeminiLocalConnection(connection, environment, signal);
  return true;
}
