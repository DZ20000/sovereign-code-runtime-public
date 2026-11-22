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
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$inputValue=[Console]::In.ReadToEnd()|ConvertFrom-Json
if($inputValue.mode -eq 'protect'){
  $result=ConvertTo-SecureString $inputValue.value -AsPlainText -Force|ConvertFrom-SecureString
}else{
  $result=[Net.NetworkCredential]::new('',(ConvertTo-SecureString $inputValue.value)).Password
}
[Console]::Out.Write($result)
`, "utf16le").toString("base64");

function transformSecret(mode: "protect" | "restore", value: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = join(environment.SystemRoot ?? environment.WINDIR ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]
      .flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]));
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", codec], {
      shell: false, windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.stdin.on("error", () => undefined);
    child.once("close", (code) => code === 0 && output.trim() ? resolve(output.trim())
      : reject(new Error(`Local Gemini connection protection failed (exit ${String(code)}).`)));
    child.stdin.end(JSON.stringify({ mode, value }));
  });
}

export async function readRegisteredGeminiConnection(environment = process.env) {
  const path = pairingPath(environment);
  if (process.platform !== "win32" || !path) return null;
  let protectedValue: string;
  try { protectedValue = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return parseGeminiLocalConnection(JSON.parse(await transformSecret("restore", protectedValue.trim(), environment)));
}

/** Register a connection explicitly; credentials remain protected by the current Windows account. */
export async function registerGeminiLocalConnection(value: unknown, environment = process.env) {
  const connection = parseGeminiLocalConnection(value);
  const path = pairingPath(environment);
  if (process.platform !== "win32" || !path) throw new Error("Protected Gemini pairing requires Windows LOCALAPPDATA.");
  const protectedValue = await transformSecret("protect", JSON.stringify(connection), environment);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.gemini-connection-${randomUUID()}.tmp`);
  try { await writeFile(temporary, protectedValue, { encoding: "ascii", flag: "wx" }); await rename(temporary, path); }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  return connection;
}

/** An owner-initiated Gateway update may refresh only an existing local pairing. */
export async function refreshRegisteredGeminiConnection(endpoint: string, bearerToken: string, environment = process.env) {
  const previous = await readRegisteredGeminiConnection(environment);
  if (!previous) return false;
  const connection = parseGeminiLocalConnection({ ...previous, transport: { ...previous.transport, url: endpoint,
    headers: { Authorization: `Bearer ${bearerToken}` } } });
  if (JSON.stringify(previous) === JSON.stringify(connection)) return false;
  await registerGeminiLocalConnection(connection, environment);
  return true;
}
