import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerGeminiLocalConnection } from "../src/gemini-local-connection.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

const fixtureSecret = "gemini-process-fixture-secret-123456";
const connection = {
  schemaVersion: "scr.connection/v1", name: "sovereign-code-runtime",
  transport: { type: "streamable-http", url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: `Bearer ${fixtureSecret}` } },
};
let root: string;
let child: FakeChild;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "so-gemini-process-"));
  child = new FakeChild();
  spawn.mockReset().mockReturnValue(child);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  try {
    // A failed or cancelled registration must not create even the isolated LOCALAPPDATA directory.
    expect(await readdir(root)).toEqual([]);
  } finally {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

function beginRegistration(signal?: AbortSignal): Promise<unknown> {
  // Exercise the Windows-only public API on every test platform without a real child.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    return registerGeminiLocalConnection(connection, { LOCALAPPDATA: join(root, "local-app-data") }, signal)
      .catch((error: unknown) => error);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

async function expectFailure(result: Promise<unknown>, reason: string, stage = "spawn", wasRunning = true) {
  const failure = await result;
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", `Local Gemini connection protect failed (${reason}; stage ${stage}).`);
  expect(String(failure)).not.toContain(fixtureSecret);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledTimes(wasRunning ? 1 : 0);
  expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
  expect(vi.getTimerCount()).toBe(0);
}

it("rejects a stalled protection process at the deadline and releases all pipes", async () => {
  const result = beginRegistration();
  let settled = false;
  void result.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(19_999);
  expect(settled).toBe(false);
  expect(child.kill).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await expectFailure(result, "timed out after 20000 ms");
  child.exitCode = 0;
  child.emit("close", 0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it("bounds cumulative stdout by UTF-8 bytes and rejects the first byte overflow", async () => {
  const result = beginRegistration();
  const chunk = Buffer.from("é".repeat(128 * 1024), "utf8");
  child.stdout.write(chunk);
  child.stdout.write(chunk);
  expect(child.kill).not.toHaveBeenCalled(); // Exactly 512 KiB, across two chunks.
  child.stdout.write("é"); // Still below 512 KiB in UTF-16 code units.
  await expectFailure(result, "output exceeded the protection limit");
});

it("reports only complete fixed stages and never raw stderr on a failed exit", async () => {
  const result = beginRegistration();
  child.stderr.write(`PowerShell diagnostic: ${fixtureSecret}\nSCR_DPAPI_STA`);
  child.stderr.write("GE:transformed\r\nSCR_DPAPI_STAGE:written");
  child.stderr.write(`-${fixtureSecret}\n`);
  child.exitCode = 7;
  child.emit("close", 7);
  await expectFailure(result, "exit 7", "transformed", false);
});

it("sanitizes child errors and tolerates a later error after failure", async () => {
  const result = beginRegistration();
  child.emit("error", new Error(`spawn diagnostic: ${fixtureSecret}`));
  await expectFailure(result, "process could not start");
  expect(() => child.emit("error", new Error(`kill diagnostic: ${fixtureSecret}`))).not.toThrow();
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it.each([
  ["stdin", "input"], ["stdout", "output"], ["stderr", "diagnostic"],
] as const)("sanitizes a %s pipe failure and releases the child", async (pipe, label) => {
  const result = beginRegistration();
  child[pipe].emit("error", new Error(`pipe diagnostic: ${fixtureSecret}`));
  await expectFailure(result, `${label} pipe failed`);
});

it("still releases pipes and rejects safely when killing the child throws", async () => {
  child.kill.mockImplementation(() => { throw new Error(`kill diagnostic: ${fixtureSecret}`); });
  const result = beginRegistration();
  child.stdin.emit("error", new Error(`input diagnostic: ${fixtureSecret}`));
  await expectFailure(result, "input pipe failed");
});

it("cancels a stalled protection process without disclosing the abort reason", async () => {
  const controller = new AbortController();
  const result = beginRegistration(controller.signal);
  controller.abort(new Error(`abort diagnostic: ${fixtureSecret}`));
  await expectFailure(result, "cancelled");
});

it("cancels before any pairing write when protection completes just before abort", async () => {
  const controller = new AbortController();
  const result = beginRegistration(controller.signal);
  child.stdout.write("protected-fixture-value");
  child.exitCode = 0;
  child.emit("close", 0);
  // Abort in the same turn, before register can continue after its transform await.
  controller.abort(new Error(`abort diagnostic: ${fixtureSecret}`));

  const failure = await result;
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "Local Gemini connection update was cancelled.");
  expect(String(failure)).not.toContain(fixtureSecret);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
