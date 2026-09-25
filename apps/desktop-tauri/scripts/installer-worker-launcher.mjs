import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_SCHEDULED_TASK_COMMAND_LENGTH = 261;

function quotedWindowsArgument(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n"]/u.test(value)) {
    throw new Error(`${label} is not safe for a scheduled-task command line.`);
  }
  return `"${value}"`;
}

export function buildScheduledTaskCommand(nodePath, runnerPath) {
  const command = [
    quotedWindowsArgument(resolve(nodePath), "Node executable path"),
    quotedWindowsArgument(resolve(runnerPath), "Installer worker runner path"),
  ].join(" ");
  if (command.length > MAX_SCHEDULED_TASK_COMMAND_LENGTH) {
    throw new Error(
      `Scheduled installer command exceeds ${MAX_SCHEDULED_TASK_COMMAND_LENGTH} characters: ${command.length}.`,
    );
  }
  return command;
}

function runnerSource({ launcherRoot, scriptPath, workerArguments }) {
  const moduleUrl = `${pathToFileURL(scriptPath).href}?installer-worker=${randomUUID()}`;
  return `import { rm } from "node:fs/promises";\n` +
    `const launcherRoot = ${JSON.stringify(launcherRoot)};\n` +
    `try {\n` +
    `  process.argv = [process.execPath, ${JSON.stringify(scriptPath)}, ...${JSON.stringify(workerArguments)}];\n` +
    `  await import(${JSON.stringify(moduleUrl)});\n` +
    `} finally {\n` +
    `  await rm(launcherRoot, { recursive: true, force: true, maxRetries: 24, retryDelay: 250 }).catch(() => undefined);\n` +
    `}\n`;
}

export async function cleanupInstallerWorkerLauncher(launcher) {
  if (launcher === null || launcher === undefined) return;
  await rm(launcher.root, {
    recursive: true,
    force: true,
    maxRetries: 24,
    retryDelay: 250,
  });
}

export async function createInstallerWorkerLauncher({
  localAppData,
  nodePath,
  scriptPath,
  manifestPath,
  taskName,
  logPath,
}) {
  const shortRoot = resolve(localAppData, "SCR", "i");
  await mkdir(shortRoot, { recursive: true });
  const root = resolve(shortRoot, randomUUID().replaceAll("-", "").slice(0, 16));
  await mkdir(root);
  const runnerPath = resolve(root, "w.mjs");
  const workerArguments = [
    "--worker",
    "--manifest",
    resolve(manifestPath),
    "--task-name",
    taskName,
    "--log",
    resolve(logPath),
  ];
  try {
    await writeFile(
      runnerPath,
      runnerSource({
        launcherRoot: root,
        scriptPath: resolve(scriptPath),
        workerArguments,
      }),
      { encoding: "utf8", flag: "wx" },
    );
    const info = await lstat(runnerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error("Installer worker runner must be one unshared direct regular file.");
    }
    const command = buildScheduledTaskCommand(nodePath, runnerPath);
    return {
      root,
      runnerPath,
      command,
      workerArguments,
    };
  } catch (error) {
    await cleanupInstallerWorkerLauncher({ root }).catch(() => undefined);
    throw error;
  }
}
