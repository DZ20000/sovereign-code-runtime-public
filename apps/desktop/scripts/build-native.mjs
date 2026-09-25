import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const sourcePath = join(desktopRoot, "native", "SovereignNativeAgent.cs");
const outputDirectory = join(desktopRoot, "native", "bin");
const outputPath = join(outputDirectory, "SovereignNativeAgent.exe");

if (process.platform !== "win32") {
  console.log("Native Windows agent compilation skipped outside Windows.");
  process.exit(0);
}

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const candidates = [
  process.env.SCR_CSC_PATH,
  join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
const compiler = candidates.find((candidate) => existsSync(candidate));
if (compiler === undefined) {
  throw new Error(
    "The .NET Framework C# compiler was not found. Set SCR_CSC_PATH to csc.exe.",
  );
}
if (!existsSync(sourcePath)) {
  throw new Error(`Native agent source is missing: ${sourcePath}`);
}

await mkdir(outputDirectory, { recursive: true });
const source = await readFile(sourcePath, "utf8");
const buildSourcePath = join(outputDirectory, ".SovereignNativeAgent.build.cs");
await writeFile(buildSourcePath, source, "utf8");
const args = [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  "/optimize+",
  "/checked+",
  `/out:${outputPath}`,
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  buildSourcePath,
];

try {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(compiler, args, {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`Native agent compilation failed with exit code ${exitCode}.`));
      }
    });
  });
} finally {
  await rm(buildSourcePath, { force: true });
}

console.log(`Native Windows agent ready: ${outputPath}`);
