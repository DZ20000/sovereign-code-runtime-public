import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { availableParallelism, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { TaskRegistry } from "../packages/control-plane/dist/task-registry.js";

// Standalone synthetic benchmark, not a replacement for capacity acceptance tests.
// Run `pnpm build:runtime` first. No live Task database or credentials are accessed.
const mode = process.argv[2];
assert.ok(mode === "profile" || mode === "control", "Expected profile or control");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExec = DatabaseSync.prototype.exec;
let active = false, phase = "idle", observedDatabase;
const sqlTimes = new Map();
const normalize = (sql) => sql.replace(/\s+/g, " ").trim();
function record(op, sql, ms) {
  const text = normalize(sql);
  const key = `${phase}\n${op}\n${text}`;
  let item = sqlTimes.get(key);
  if (!item) {
    item = { phase, op, sql: text, count: 0, totalMs: 0, maxMs: 0 };
    sqlTimes.set(key, item);
  }
  item.count += 1;
  item.totalMs += ms;
  item.maxMs = Math.max(item.maxMs, ms);
}
if (mode === "profile") {
  DatabaseSync.prototype.exec = function (sql) {
    observedDatabase ??= this;
    if (!active) return originalExec.call(this, sql);
    const start = performance.now();
    try { return originalExec.call(this, sql); }
    finally { record("exec", sql, performance.now() - start); }
  };
  DatabaseSync.prototype.prepare = function (sql) {
    observedDatabase ??= this;
    const start = performance.now();
    const statement = originalPrepare.call(this, sql);
    if (active) record("prepare", sql, performance.now() - start);
    for (const op of ["get", "all", "run"]) {
      const original = statement[op];
      statement[op] = function (...args) {
        if (!active) return Reflect.apply(original, this, args);
        const t = performance.now();
        try { return Reflect.apply(original, this, args); }
        finally { record(op, sql, performance.now() - t); }
      };
    }
    return statement;
  };
}
const phases = [], samples = [];
function measure(label, fn) {
  phase = label;
  active = true;
  const start = performance.now();
  try { return fn(); }
  finally {
    phases.push({ phase: label, ms: performance.now() - start });
    active = false;
    phase = "idle";
  }
}
const parent = await realpath(tmpdir());
const root = await mkdtemp(join(parent, "scr-task-capacity-profile-"));
const workspace = join(root, "workspace");
const reportDir = resolve(".sovereign/reports/capacity-diagnostics");
await mkdir(workspace);
await mkdir(reportDir, { recursive: true });
const changes = [];
let registry, error = null, pragmas = null, invariants = null, scenarioMs = null;
const cpuStart = process.cpuUsage();
const start = performance.now();
try {
  registry = measure("registry-init", () => new TaskRegistry({
    databasePath: join(root, "tasks.sqlite"), onChanged: () => changes.push(Date.now()),
  }));
  if (observedDatabase) {
    pragmas = Object.fromEntries(["journal_mode", "synchronous", "busy_timeout", "wal_autocheckpoint", "page_size"]
      .map((key) => [key, originalPrepare.call(observedDatabase, `PRAGMA ${key}`).get()]));
    pragmas.sqlite = originalPrepare.call(observedDatabase, "SELECT sqlite_version() AS version").get();
  }
  const tasks = measure("create-five-tasks", () => Array.from({ length: 5 }, (_, i) => registry.createTask({
    title: `Conversation ${i + 1}`, agentId: `agent-${i + 1}`, agentName: `Agent ${i + 1}`,
  }, "chatgpt-web", workspace)));
  for (const [i, task] of tasks.entries()) {
    measure(`append-task-${i + 1}`, () => {
      for (let j = 0; j < 450; j += 1) {
        const t = performance.now();
        registry.addAgentMessage(task.id, `Task ${i + 1} message ${j + 1}`, "assistant", `agent-${i + 1}`, `Agent ${i + 1}`, "chatgpt-web");
        samples.push({ task: i + 1, message: j + 1, ms: performance.now() - t });
      }
    });
    console.log(JSON.stringify({ mode, completedPhase: phases.at(-1) }));
  }
  const snapshot = measure("snapshot", () => registry.snapshot());
  const retained = snapshot.projects.flatMap((p) => p.tasks).reduce((n, t) => n + t.messageCount, 0);
  const last = measure("detail", () => registry.detail(tasks.at(-1).id, 500).messages.at(-1));
  assert.equal(retained, 2000);
  assert.equal(last.content, "Task 5 message 450");
  invariants = { retainedMessages: retained, lastContent: last.content, changeCallbacks: changes.length };
  measure("registry-close", () => registry.close());
  registry = null;
  scenarioMs = performance.now() - start;
} catch (e) {
  error = { name: e.name, message: e.message, code: e.code };
  process.exitCode = 1;
} finally {
  active = false;
  try { registry?.close(); }
  finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    DatabaseSync.prototype.exec = originalExec;
  }
}
const sql = [...sqlTimes.values()].sort((a, b) => b.totalMs - a.totalMs);
const commits = sql.filter((s) => s.op === "exec" && /^COMMIT/i.test(s.sql));
const pruning = sql.filter((s) => s.op === "run" && /^DELETE FROM task_messages/i.test(s.sql));
const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
const percentile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null;
const sum = (rows, key) => rows.reduce((n, s) => n + s[key], 0);
const hashes = {};
for (const path of ["packages/control-plane/src/task-registry.ts", "packages/control-plane/src/task-message-retention.ts", "packages/control-plane/dist/task-registry.js", "scripts/task-retention-profile.mjs"]) {
  hashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
}
const cpu = process.cpuUsage(cpuStart);
const report = {
  schemaVersion: "so.capacity-profile/v2", mode, head, generatedAt: new Date().toISOString(), hashes,
  environment: { platform: process.platform, release: release(), node: process.version, parallelism: availableParallelism(),
    runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null },
  pragmas, scenarioMs, referenceTestBudgetMs: 60000, withinReferenceBudget: scenarioMs !== null && scenarioMs <= 60000,
  cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, phases,
  perMessage: { count: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) },
  commits: mode === "profile" ? { count: sum(commits, "count"), ms: sum(commits, "totalMs") } : null,
  pruning: mode === "profile" ? { count: sum(pruning, "count"), ms: sum(pruning, "totalMs") } : null,
  invariants, error, sql, samples,
  notes: ["Native SQL call timing is not a direct disk-flush trace. No durability setting is modified.",
    "This diagnostic records complete timings, including overruns; it does not replace or relax the original Vitest budget."],
};
const output = join(reportDir, `${mode}-${Date.now()}.json`);
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log("CAPACITY_PROFILE_RESULT " + JSON.stringify({ ...report, sql: sql.slice(0, 8), samples: undefined }));
// Cleanup is limited to the fresh synthetic directory and refuses redirected paths.
assert.equal((await lstat(root)).isSymbolicLink(), false);
const canonical = await realpath(root);
assert.equal(dirname(canonical), parent);
assert.ok(basename(canonical).startsWith("scr-task-capacity-profile-"));
await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
if (!report.withinReferenceBudget) process.exitCode = 1;
