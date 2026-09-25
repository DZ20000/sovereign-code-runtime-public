#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_MAX_WORKTREES = 8;
const DEFAULT_MAX_DIRTY_WORKTREES = 4;
const DEFAULT_STALE_HOURS = 24;

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "git command failed").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gitText(args, options = {}) {
  return runGit(args, options).stdout.trim();
}

function normalizeForComparison(value) {
  const normalized = resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseWorktreePorcelain(raw) {
  const records = [];
  let current = null;
  const flush = () => {
    if (current !== null) records.push(current);
    current = null;
  };
  for (const line of raw.split(/\r?\n/u)) {
    if (line.length === 0) {
      flush();
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? true : line.slice(separator + 1);
    if (key === "worktree") {
      flush();
      current = { path: value };
    } else if (current !== null) {
      current[key] = value;
    }
  }
  flush();
  return records;
}

function repositoryContext() {
  const currentRoot = gitText(["rev-parse", "--show-toplevel"]);
  const commonDir = gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const primaryRoot = dirname(commonDir);
  const managedRoot = join(primaryRoot, ".worktrees");
  return { currentRoot, commonDir, primaryRoot, managedRoot };
}

function assertManagedPath(path, context, { mustExist }) {
  if (!isAbsolute(path)) throw new Error(`Managed worktree path must be absolute: ${path}`);
  const target = resolve(path);
  const managedRoot = resolve(context.managedRoot);
  const rel = relative(managedRoot, target);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing path outside the managed worktree root: ${target}`);
  }
  if (dirname(target) !== managedRoot) {
    throw new Error(`Managed worktrees must be direct children of ${managedRoot}: ${target}`);
  }
  const root = resolve(target).match(/^[A-Za-z]:\\?$/u);
  if (root !== null || normalizeForComparison(target) === normalizeForComparison(context.primaryRoot)) {
    throw new Error(`Refusing a repository or volume root as a worktree target: ${target}`);
  }
  if (mustExist) {
    if (!existsSync(target)) throw new Error(`Worktree path does not exist: ${target}`);
    const realTarget = realpathSync.native(target);
    const realManaged = existsSync(managedRoot) ? realpathSync.native(managedRoot) : managedRoot;
    const realRel = relative(realManaged, realTarget);
    if (realRel.length === 0 || realRel.startsWith("..") || isAbsolute(realRel)) {
      throw new Error(`Resolved worktree escapes the managed root: ${realTarget}`);
    }
  }
  return target;
}

function inspectWorktrees() {
  const context = repositoryContext();
  const records = parseWorktreePorcelain(gitText(["worktree", "list", "--porcelain"]));
  const now = Date.now();
  return {
    context,
    worktrees: records.map((record) => {
      const path = resolve(record.path);
      const status = runGit(
        ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"],
        { allowFailure: true },
      );
      const dirtyEntries = status.ok
        ? status.stdout.split(/\r?\n/u).filter(Boolean)
        : ["<unreadable>"];
      let createdMs = now;
      try {
        const stats = statSync(path);
        createdMs = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
      } catch {
        createdMs = now;
      }
      return {
        path,
        name: basename(path),
        branch: typeof record.branch === "string"
          ? record.branch.replace(/^refs\/heads\//u, "")
          : "<detached>",
        head: typeof record.HEAD === "string" ? record.HEAD.slice(0, 12) : "<unknown>",
        dirtyEntries,
        dirty: dirtyEntries.length > 0,
        locked: record.locked !== undefined,
        ageHours: Math.max(0, (now - createdMs) / 3_600_000),
        isCurrent: normalizeForComparison(path) === normalizeForComparison(context.currentRoot),
        isPrimary: normalizeForComparison(path) === normalizeForComparison(context.primaryRoot),
      };
    }),
  };
}

function numberOption(args, name, fallback) {
  const index = args.indexOf(name);
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  const raw = inline?.slice(name.length + 1) ?? (index >= 0 ? args[index + 1] : undefined);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative.`);
  return parsed;
}

function printAudit(worktrees) {
  console.table(worktrees.map((worktree) => ({
    name: worktree.name,
    branch: worktree.branch,
    dirty: worktree.dirtyEntries.length,
    ageHours: Number(worktree.ageHours.toFixed(1)),
    current: worktree.isCurrent,
    primary: worktree.isPrimary,
    locked: worktree.locked,
  })));
}

function guard(worktrees, args, extra = 0) {
  const max = numberOption(args, "--max", DEFAULT_MAX_WORKTREES);
  const maxDirty = numberOption(args, "--max-dirty", DEFAULT_MAX_DIRTY_WORKTREES);
  const dirty = worktrees.filter((worktree) => worktree.dirty).length;
  const total = worktrees.length + extra;
  if (total > max || dirty > maxDirty) {
    printAudit(worktrees);
    throw new Error(
      `Worktree guard failed: total=${total}/${max}, dirty=${dirty}/${maxDirty}. Reuse or finish an existing worktree.`,
    );
  }
  console.log(`Worktree guard passed: total=${total}/${max}, dirty=${dirty}/${maxDirty}.`);
}

function removeCleanWorktree(worktree, context) {
  if (worktree.isCurrent || worktree.isPrimary) throw new Error("Refusing to remove the current or primary worktree.");
  if (worktree.locked) throw new Error(`Refusing to remove locked worktree ${worktree.name}.`);
  if (worktree.dirty) {
    throw new Error(`Refusing to remove dirty worktree ${worktree.name}: ${worktree.dirtyEntries[0]}`);
  }
  const target = assertManagedPath(worktree.path, context, { mustExist: true });
  const ignored = runGit([
    "-C", target, "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
  ]).stdout.split("\0").filter(Boolean);
  if (ignored.length > 0) {
    throw new Error(
      `Refusing to remove worktree ${worktree.name}: ${ignored.length} ignored path(s) remain, including ${JSON.stringify(ignored[0])}. Review and preserve or dispose of these contents before finishing.`,
    );
  }
  runGit(["worktree", "remove", target], { inherit: true });
}

function createWorktree(worktrees, context, args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const name = positional[0];
  if (name === undefined || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(name)) {
    throw new Error("Usage: pnpm worktree:create -- <lowercase-slug> [branch] [start-point]");
  }
  guard(worktrees, args, 1);
  const branch = positional[1] ?? `feature/${name}`;
  const startPoint = positional[2] ?? "HEAD";
  const target = assertManagedPath(join(context.managedRoot, name), context, { mustExist: false });
  if (existsSync(target)) throw new Error(`Target already exists: ${target}`);
  const branchExists = runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowFailure: true },
  ).ok;
  runGit(
    branchExists
      ? ["worktree", "add", target, branch]
      : ["worktree", "add", "-b", branch, target, startPoint],
    { inherit: true },
  );
  console.log(`Created ${target}. Reuse it for all follow-up work on ${branch}.`);
}

function prune(worktrees, context, args) {
  const allClean = args.includes("--all-clean");
  const staleHours = numberOption(args, "--older-than-hours", DEFAULT_STALE_HOURS);
  const candidates = worktrees.filter((worktree) =>
    !worktree.isCurrent
    && !worktree.isPrimary
    && !worktree.dirty
    && !worktree.locked
    && (allClean || worktree.ageHours >= staleHours),
  );
  printAudit(candidates);
  console.log(`${candidates.length} clean candidate(s); no worktrees removed. Age and clean Git status do not establish inactivity.`);
  console.log("After confirming the owner has finished, use pnpm worktree:finish -- <name> for one managed worktree.");
}

function finish(worktrees, context, args) {
  const name = args.find((arg) => !arg.startsWith("--"));
  if (name === undefined) throw new Error("Usage: pnpm worktree:finish -- <worktree-name>");
  const worktree = worktrees.find((candidate) => candidate.name === name);
  if (worktree === undefined) throw new Error(`Unknown registered worktree: ${name}`);
  removeCleanWorktree(worktree, context);
  runGit(["worktree", "prune"], { inherit: true });
  console.log(`Removed ${name}; branch ${worktree.branch} remains available.`);
}

try {
  const [, , command = "audit", ...args] = process.argv;
  const { context, worktrees } = inspectWorktrees();
  switch (command) {
    case "audit":
      printAudit(worktrees);
      break;
    case "guard":
      guard(worktrees, args);
      break;
    case "prune":
      prune(worktrees, context, args);
      break;
    case "create":
      createWorktree(worktrees, context, args);
      break;
    case "finish":
      finish(worktrees, context, args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
