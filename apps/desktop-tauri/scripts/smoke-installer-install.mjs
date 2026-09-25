import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyInstallerPackage } from "./installer-package.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerScript = resolve(projectRoot, "scripts", "install-nsis-and-restart.mjs");
const verifierScript = resolve(projectRoot, "scripts", "verify-installed-nsis.mjs");
const defaultManifestPath = resolve(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  "installer-package.json",
);

function parseArguments(argv) {
  const options = {
    apply: false,
    dryRun: false,
    manifestPath: defaultManifestPath,
    passes: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") {
      options.apply = true;
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === "--manifest" || value === "--passes") {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new Error(`${value} requires a value.`);
      }
      index += 1;
      if (value === "--manifest") options.manifestPath = resolve(next);
      if (value === "--passes") {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
          throw new Error("--passes must be an integer from 1 through 3.");
        }
        options.passes = parsed;
      }
      continue;
    }
    throw new Error(`Unknown installer smoke argument: ${value}`);
  }
  if (options.apply === options.dryRun) {
    throw new Error("Choose exactly one of --apply or --dry-run.");
  }
  return options;
}

function runNodeScript(script, argumentsValue, timeoutMs) {
  const result = spawnSync(process.execPath, [script, ...argumentsValue], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${script} exited with code ${String(result.status)}.`,
    );
  }
  return JSON.parse(result.stdout);
}

const options = parseArguments(process.argv.slice(2));
if (process.platform !== "win32") {
  throw new Error("The NSIS install/reinstall smoke is Windows-only.");
}
const verification = await verifyInstallerPackage(options.manifestPath);
if (!verification.passed) {
  throw new Error(`Installer package verification failed: ${verification.problems.join("; ")}`);
}
if (verification.manifest.source.dirty) {
  throw new Error("Refusing to install a package produced from dirty source.");
}

if (options.dryRun) {
  const cutoverPlan = runNodeScript(
    installerScript,
    ["--dry-run", "--manifest", verification.manifestPath],
    30_000,
  );
  console.log(JSON.stringify({
    dryRun: true,
    passes: options.passes,
    cutoverPlan,
    postInstallVerifier: [
      process.execPath,
      verifierScript,
      "--manifest",
      verification.manifestPath,
      "--require-running",
    ],
  }, null, 2));
  process.exit(0);
}

const localAppData = process.env.LOCALAPPDATA ?? projectRoot;
const results = [];
for (let pass = 1; pass <= options.passes; pass += 1) {
  const nonce = `${Date.now()}-${process.pid}-${pass}`;
  const taskName = `Sovereign-Installer-Smoke-${nonce}`;
  const logPath = resolve(
    localAppData,
    "Sovereign Code Runtime",
    "install-logs",
    `${taskName}.log`,
  );
  const cutover = runNodeScript(
    installerScript,
    [
      "--worker",
      "--manifest",
      verification.manifestPath,
      "--task-name",
      taskName,
      "--log",
      logPath,
    ],
    300_000,
  );
  if (
    cutover.installed !== true ||
    cutover.recovered !== false ||
    cutover.userDataPreserved !== true ||
    cutover.preservationBackupCleaned !== true
  ) {
    throw new Error(`Installer pass ${pass} returned an incomplete cutover result: ${JSON.stringify(cutover)}`);
  }
  const installed = runNodeScript(
    verifierScript,
    ["--manifest", verification.manifestPath, "--require-running"],
    60_000,
  );
  if (installed.passed !== true) {
    throw new Error(`Installed-package verification failed after pass ${pass}.`);
  }
  results.push({ pass, cutover, installed });
}

console.log(JSON.stringify({
  passed: true,
  passes: options.passes,
  manifestPath: verification.manifestPath,
  manifestSha256: verification.manifestSha256,
  sourceCommit: verification.manifest.source.commit,
  results,
}, null, 2));
