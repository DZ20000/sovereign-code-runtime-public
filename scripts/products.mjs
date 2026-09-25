#!/usr/bin/env node
// Locate existing products; never build, install, launch, copy, or delete them.
import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { verifyInstalledExecutable, verifyInstallerPackage } from "../apps/desktop-tauri/scripts/installer-package.mjs";
import { verifyPortablePackage } from "../apps/desktop-tauri/scripts/release-metadata.mjs";
import { escapePowerShellLiteral, runPowerShell } from "../apps/desktop-tauri/scripts/portable-launcher.mjs";
import { findInstalledApplications } from "../apps/desktop-tauri/scripts/installed-application.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const labels = { installed: "已安装的 Windows 版", running: "正在运行的 Windows 版", installer: "Windows 安装包", android: "Android 开发预览 APK", portable: "Windows 便携包" };

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function containedFile(parent, candidate) {
  if (!inside(parent, candidate)) throw new Error("Product path escapes its output directory.");
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !inside(await realpath(parent), await realpath(candidate))) {
    throw new Error("Product must be a contained direct regular file.");
  }
  return info;
}

async function metadata(path) {
  const info = await containedFile(dirname(path), path);
  if (info.size > 1024 * 1024) throw new Error("Product metadata exceeds 1 MiB.");
  return JSON.parse(await readFile(path, "utf8"));
}

export function sortProducts(items) {
  const order = Object.keys(labels);
  return items.slice().sort((a, b) => Number(Boolean(b.running)) - Number(Boolean(a.running))
    || order.indexOf(a.kind) - order.indexOf(b.kind)
    || (a.kind === "android" ? (b.versionCode ?? 0) - (a.versionCode ?? 0) : 0)
    || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    || a.path.localeCompare(b.path));
}

export async function collectProducts(worktrees) {
  const items = [], warnings = [];
  for (const worktree of worktrees) {
    const desktop = resolve(worktree, "apps/desktop-tauri");
    const sources = {
      installer: resolve(desktop, "src-tauri/target/release/bundle/nsis/installer-package.json"),
      portable: resolve(desktop, "artifacts/latest-portable.json"),
      android: resolve(worktree, "apps/android-agent/app/build/outputs/apk/debug/output-metadata.json"),
    };
    for (const [kind, source] of Object.entries(sources)) {
      try {
        await lstat(source); // Only an absent manifest means this product has not been built.
      } catch (error) {
        if (error.code !== "ENOENT") warnings.push({ worktree, kind, error: error.message });
        continue;
      }
      try {
        const value = await metadata(source);
        if (kind === "installer") {
          const result = await verifyInstallerPackage(source);
          if (!result.passed || result.manifest.product.identifier !== "com.sovereign.runtime") {
            throw new Error("Installer manifest verification failed.");
          }
          items.push({ kind, worktree, path: result.installerPath, version: result.manifest.product.version,
            installedExecutable: result.manifest.installedExecutable,
            sourceCommit: result.manifest.source.commit, sourceDirty: result.manifest.source.dirty,
            createdAt: result.manifest.createdAt, verification: "manifest-verified" });
        } else if (kind === "portable") {
          if (value.schemaVersion !== "scr.portable-pointer/v1" || typeof value.portableRoot !== "string"
            || !inside(resolve(desktop, "artifacts"), value.portableRoot)) throw new Error("Invalid portable pointer.");
          const executable = resolve(value.portableRoot, "SovereignCodeRuntime.exe");
          await containedFile(resolve(desktop, "artifacts"), executable);
          const result = await verifyPortablePackage(value.portableRoot);
          if (!result.passed || result.manifestSha256 !== value.manifestSha256
            || !result.componentChecks.some(component => component.path === "SovereignCodeRuntime.exe" && component.matched)) {
            throw new Error("Portable manifest verification failed for the displayed executable.");
          }
          items.push({ kind, worktree, path: executable, version: result.productVersion,
            sourceCommit: result.sourceCommit, sourceDirty: result.sourceDirty,
            createdAt: value.updatedAt, verification: "manifest-verified" });
        } else {
          if (!/^com\.sovereign\.runtime\.android(?:\.debug)?$/u.test(value.applicationId ?? "") || !Array.isArray(value.elements)) {
            throw new Error("Invalid Sovereign Android build metadata.");
          }
          for (const element of value.elements) {
            if (typeof element.outputFile !== "string" || !element.outputFile.endsWith(".apk")
              || !Number.isSafeInteger(element.versionCode) || typeof element.versionName !== "string") throw new Error("Invalid APK entry.");
            const path = resolve(dirname(source), element.outputFile);
            const info = await containedFile(dirname(source), path);
            items.push({ kind, worktree, path, version: element.versionName, versionCode: element.versionCode,
              createdAt: info.mtime.toISOString(), verification: "build-metadata-only" });
          }
        }
      } catch (error) {
        warnings.push({ worktree, kind, error: String(error.message).slice(0, 500) });
      }
    }
  }
  return { items: sortProducts(items), warnings };
}

function registeredWorktrees() {
  const git = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", windowsHide: true, shell: false });
  if (git.status !== 0) throw new Error(git.stderr || "Cannot list repository worktrees.");
  return [...new Set(git.stdout.split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9)))];
}

function runningProducts() {
  if (process.platform !== "win32") return [];
  const raw = runPowerShell("@(Get-Process -Name sovereign-desktop-tauri,SovereignCodeRuntime -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique) | ConvertTo-Json -Compress");
  const values = raw ? JSON.parse(raw) : [];
  return Array.isArray(values) ? values : [values];
}

export async function collectApplicationProducts(installed, runningPaths, packages = []) {
  const items = new Map(packages.map(item => [resolve(item.path).toLowerCase(), item]));
  for (const application of installed) {
    const key = resolve(application.executable).toLowerCase();
    let verified = items.get(key);
    for (const candidate of packages.filter(item => item.kind === "installer")) {
      if (candidate.installedExecutable && (await verifyInstalledExecutable(application.executable, candidate.installedExecutable)).matched) {
        verified = { ...candidate, verification: "executable-verified" };
        break;
      }
    }
    items.set(key, { version: application.version, createdAt: null, verification: "windows-registration",
      ...verified, kind: "installed", path: application.executable, running: false });
  }
  for (const path of runningPaths) {
    try { await containedFile(dirname(path), path); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; // The process may have exited.
      throw error;
    }
    const key = resolve(path).toLowerCase();
    const item = items.get(key) ?? { kind: "running", path, version: null, createdAt: null, verification: "running-process" };
    items.set(key, { ...item, running: true });
  }
  return sortProducts([...items.values()]);
}

export async function main(args) {
  const languageIndex = args.indexOf("--lang");
  let language = "en";
  let flags = [...args];
  if (languageIndex >= 0) {
    if (args[languageIndex + 1] !== "zh-CN" || args.lastIndexOf("--lang") !== languageIndex) {
      throw new Error("Usage: node scripts/products.mjs [--json | --open] [--lang zh-CN]");
    }
    language = "zh-CN";
    flags = args.filter((_, index) => index !== languageIndex && index !== languageIndex + 1);
  }
  if (flags.some(arg => !["--json", "--open"].includes(arg)) || new Set(flags).size !== flags.length
    || flags.length > 1) throw new Error("Usage: node scripts/products.mjs [--json | --open] [--lang zh-CN]");
  const localized = language === "zh-CN";
  const localLabels = localized ? labels : {
    installed: "Installed Windows app",
    running: "Running Windows app",
    installer: "Windows installer",
    android: "Android preview APK",
    portable: "Windows portable package",
  };
  const result = await collectProducts(registeredWorktrees());
  let installed = [], running = [];
  try { installed = await findInstalledApplications(); }
  catch (error) { result.warnings.push({ kind: "installed", error: error.message }); }
  try { running = runningProducts(); }
  catch (error) { result.warnings.push({ kind: "running", error: error.message }); }
  try {
    result.items = await collectApplicationProducts(installed, running, result.items);
  } catch (error) { result.warnings.push({ kind: "running", error: error.message }); }
  if (flags.includes("--json")) { console.log(JSON.stringify(result, null, 2)); return result; }
  console.log(localized
    ? "SO 成品入口\n只定位现有文件，不安装或启动；开发预览 APK 不等于正式发行版。\n"
    : "Sovereign build outputs\nLocates existing files only; it does not install or launch them. Android APKs are development previews.\n");
  result.items.forEach((item, index) => {
    const runningSuffix = item.kind !== "running" && item.running ? (localized ? "（运行中）" : " (running)") : "";
    console.log(`${index + 1}. ${localLabels[item.kind]}${runningSuffix}  ${item.version ?? ""}  ${item.createdAt?.slice(0, 10) ?? ""}`);
    if (item.sourceCommit) console.log(localized
      ? `   来源 ${item.sourceCommit.slice(0, 12)} · ${item.sourceDirty ? "打包时含未提交改动" : "打包时工作区干净"} · ${basename(item.worktree)}`
      : `   Source ${item.sourceCommit.slice(0, 12)} · ${item.sourceDirty ? "dirty build workspace" : "clean build workspace"} · ${basename(item.worktree)}`);
    else if (item.worktree) console.log(localized ? `   来源 ${basename(item.worktree)}` : `   Source ${basename(item.worktree)}`);
    console.log(`   ${item.path}`);
  });
  for (const warning of result.warnings) console.log(localized
    ? `未列入：${warning.kind} · ${warning.worktree ?? "本机"} · ${warning.error}`
    : `Not listed: ${warning.kind} · ${warning.worktree ?? "this computer"} · ${warning.error}`);
  if (!result.items.length) console.log(localized
    ? "未找到可用成品。构建与安装说明见 releases/README.zh-CN.md。"
    : "No usable build outputs were found. See releases/README.md.");
  if (flags.includes("--open") && result.items.length) {
    if (process.platform !== "win32") throw new Error("Explorer navigation requires Windows.");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let choice;
    try { choice = (await input.question(localized
      ? "\n输入编号在资源管理器中定位，直接回车退出："
      : "\nEnter a number to reveal it in Explorer, or press Enter to exit: ")).trim(); }
    finally { input.close(); }
    if (choice === "") return result;
    if (!/^\d+$/u.test(choice) || !result.items[Number(choice) - 1]) {
      throw new Error(localized ? "无效编号；未打开文件。" : "Invalid selection; no file was opened.");
    }
    const target = result.items[Number(choice) - 1].path;
    await containedFile(dirname(target), target);
    runPowerShell(`Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('/select,"' + ${escapePowerShellLiteral(target)} + '"') -WindowStyle Hidden`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
