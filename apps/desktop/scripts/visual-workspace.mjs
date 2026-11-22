import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PREFIX = "v2-visual-";
const MARKER = "visual-run-owner.json";

function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Visual workspace must be a regular directory.");
  return realpathSync(path);
}

function contained(root, path) {
  const displacement = relative(root, path);
  if (!displacement || displacement === ".." || displacement.startsWith(".." + sep) || isAbsolute(displacement)) {
    throw new Error("Visual workspace must remain beneath its owning repository.");
  }
}

function scratchDirectory(repositoryRoot, create) {
  let current = repositoryRoot;
  for (const segment of [".sovereign", "scratch"]) {
    current = join(current, segment);
    if (create) {
      try { mkdirSync(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    current = directory(current);
    contained(repositoryRoot, current);
  }
  return current;
}

/** Ignores inherited output/profile paths and creates one new owned run directory. */
export function createVisualWorkspace(repositoryPath) {
  const repositoryRoot = directory(resolve(repositoryPath));
  const scratch = scratchDirectory(repositoryRoot, true);
  const outputRoot = mkdtempSync(join(scratch, PREFIX));
  const userDataRoot = join(outputRoot, "user-data");
  mkdirSync(userDataRoot);
  const runId = randomUUID();
  writeFileSync(join(outputRoot, MARKER), JSON.stringify({ schemaVersion: "scr.visual-workspace/v1", runId }), { flag: "wx" });
  return { repositoryRoot, outputRoot, userDataRoot, runId };
}

/** Runs before Electron receives a profile path; an arbitrary environment path is never trusted. */
export function validateVisualWorkspace(repositoryPath, environment) {
  const repositoryRoot = directory(resolve(repositoryPath));
  const scratch = scratchDirectory(repositoryRoot, false);
  const output = environment.SCR_VISUAL_OUTPUT;
  const userData = environment.SCR_VISUAL_USER_DATA;
  const runId = environment.SCR_VISUAL_RUN_ID;
  if (typeof output !== "string" || !isAbsolute(output) || typeof userData !== "string" || !isAbsolute(userData)
      || typeof runId !== "string" || !/^[a-f0-9-]{36}$/u.test(runId)) {
    throw new Error("Visual tests must be launched with a fresh owned workspace.");
  }
  const outputRoot = directory(resolve(output));
  contained(scratch, outputRoot);
  if (relative(scratch, dirname(outputRoot)) !== "" || !basename(outputRoot).startsWith(PREFIX)) {
    throw new Error("Visual output is not a direct owned scratch directory.");
  }
  const userDataRoot = directory(resolve(userData));
  if (relative(outputRoot, userDataRoot) !== "user-data") throw new Error("Visual profile escaped its run directory.");
  const markerPath = join(outputRoot, MARKER);
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024) throw new Error("Invalid visual owner marker.");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (marker.schemaVersion !== "scr.visual-workspace/v1" || marker.runId !== runId) throw new Error("Visual workspace ownership does not match.");
  return { repositoryRoot, outputRoot, userDataRoot, runId };
}

/** Evidence is retained; only the profile belonging to this completed child is disposable. */
export async function removeVisualProfile(workspace) {
  const owned = validateVisualWorkspace(workspace.repositoryRoot, {
    SCR_VISUAL_OUTPUT: workspace.outputRoot,
    SCR_VISUAL_USER_DATA: workspace.userDataRoot,
    SCR_VISUAL_RUN_ID: workspace.runId,
  });
  await rm(owned.userDataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
