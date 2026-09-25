import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { launchPortable, resolveLatestPortableExecutable, resolvePortableExecutable } from "./portable-launcher.mjs";
import { describeFile } from "./release-metadata.mjs";

test("portable resolution launches only the executable actually bound to the verified manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "scr-portable-manifest-"));
  try {
    await writeFile(join(root, "other.exe"), "verified other file");
    await writeFile(join(root, "SovereignCodeRuntime.exe"), "unverified launch file");
    await writeFile(join(root, "renderer-trusted-keys.json"), "{}");
    const components = await Promise.all(["other.exe", "renderer-trusted-keys.json"].map((name) => describeFile(join(root, name), name)));
    const manifest = {
      schemaVersion: "scr.portable-package/v2", source: { commit: "a".repeat(40), dirty: false },
      product: { version: "0.1.0" }, executable: components[0], components,
      totalBytes: components.reduce((sum, item) => sum + item.bytes, 0),
    };
    const save = () => writeFile(join(root, "portable-package.json"), JSON.stringify(manifest));
    await save();
    await assert.rejects(resolvePortableExecutable(root), /must be the verified SovereignCodeRuntime.exe/);
    const shell = await describeFile(join(root, "SovereignCodeRuntime.exe"), "SovereignCodeRuntime.exe");
    manifest.components.push(shell);
    manifest.totalBytes += shell.bytes;
    await save();
    await assert.rejects(resolvePortableExecutable(root), /must be the verified SovereignCodeRuntime.exe/);
    manifest.executable = shell;
    await save();
    assert.equal((await resolvePortableExecutable(root)).executable, join(root, "SovereignCodeRuntime.exe"));
    await writeFile(join(root, "SovereignCodeRuntime.exe"), "changed executable");
    await assert.rejects(resolvePortableExecutable(root), /failed verification/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest portable refuses a junction escaping its artifacts directory", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "scr-portable-junction-"));
  try {
    const artifacts = join(root, "artifacts");
    const outside = join(root, "outside");
    const link = join(artifacts, "portable-link");
    await mkdir(artifacts);
    await mkdir(outside);
    await symlink(outside, link, "junction");
    await writeFile(join(artifacts, "latest-portable.txt"), link);
    await assert.rejects(resolveLatestPortableExecutable(artifacts), /outside the artifacts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable launch survives the caller's kill-on-close job and reuses the exact executable", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "scr launcher ' "));
  const executable = join(root, "launch probe.exe");
  const source = join(root, "probe.cs");
  const report = `${executable}.txt`;
  const stop = `${executable}.stop`;
  const driver = join(root, "job driver.exe");
  const launch = join(root, "launch.mjs");
  const pidPath = join(root, "pid.txt");
  const marker = "SCR_PORTABLE_LAUNCH_TEST_MARKER";
  const previous = process.env[marker];
  try {
    await writeFile(source, `
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
class Probe {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  static void Main(string[] args) {
    if (args.Length == 2) {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway permission.
      if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)) ||
          !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      ProcessStartInfo start = new ProcessStartInfo(args[0], "\\\"" + args[1] + "\\\"");
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      Process child = Process.Start(start);
      child.WaitForExit();
      Environment.ExitCode = child.ExitCode;
      return; // Windows closes the only job handle and kills any remaining job members.
    }
    string path = Process.GetCurrentProcess().MainModule.FileName;
    File.WriteAllText(path + ".txt", Environment.GetEnvironmentVariable("${marker}") ?? "shell");
    for (int i = 0; i < 200 && !File.Exists(path + ".stop"); i++) Thread.Sleep(100);
    File.WriteAllText(path + ".exited", "exited");
  }
}
`);
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), [
      "/nologo", "/target:winexe", `/out:${executable}`, source,
    ], { windowsHide: true });
    await copyFile(executable, driver);
    await writeFile(launch,
      `import {writeFileSync} from 'node:fs';\n` +
      `import {launchPortable} from ${JSON.stringify(new URL("./portable-launcher.mjs", import.meta.url).href)};\n` +
      `writeFileSync(${JSON.stringify(pidPath)}, String(launchPortable(${JSON.stringify(executable)})));\n`,
    );
    process.env[marker] = "caller";
    execFileSync(driver, [process.execPath, launch], { windowsHide: true, timeout: 20_000 });
    const processId = Number(await readFile(pidPath, "utf8"));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await readFile(report, "utf8").catch(() => null) !== null) break;
      await delay(100);
    }
    await delay(300);
    assert.doesNotThrow(() => process.kill(processId, 0), "probe must survive destruction of the caller's Job Object");
    assert.equal(await readFile(report, "utf8"), "shell", "launcher must not inherit the calling agent environment");
    assert.equal(launchPortable(executable), processId, "the exact running executable must be reused");
  } finally {
    if (previous === undefined) delete process.env[marker];
    else process.env[marker] = previous;
    await writeFile(stop, "stop");
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && await readFile(`${executable}.exited`, "utf8").catch(() => null) === null) {
      await delay(100);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
