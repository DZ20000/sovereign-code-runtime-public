import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const artifactsDirectory = join(scriptsDirectory, "..", "artifacts");
const entries = await readdir(artifactsDirectory, { withFileTypes: true });
const builds = entries
  .filter((entry) => entry.isDirectory() && /^build-\d{4}-\d{2}-\d{2}T/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

if (builds.length <= 1) {
  console.log(`Artifact retention: ${builds.length} build retained.`);
  process.exit(0);
}

const retainedBuild = builds.at(-1);
let removedBuilds = 0;
const busyBuilds = [];
for (const build of builds.slice(0, -1)) {
  try {
    await rm(join(artifactsDirectory, build), {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
    removedBuilds += 1;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
      busyBuilds.push(build);
      continue;
    }
    throw error;
  }
}

console.log(
  `Artifact retention: kept ${retainedBuild}; removed ${removedBuilds} older build(s)` +
    (busyBuilds.length === 0 ? "." : `; skipped ${busyBuilds.length} busy build(s).`),
);
