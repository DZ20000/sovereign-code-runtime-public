#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

const INPUT_SCHEMA_VERSION = "scr.session-handoff-input/v1";
const OUTPUT_SCHEMA_VERSION = "scr.session-handoff/v1";
const CONTINUATION_ANCHOR_SCHEMA_VERSION = "scr.session-continuation-anchor/v1";
const CONTINUATION_ANCHOR_MARKER = "SCR_SESSION_CONTINUATION_ANCHOR";
const HANDOFF_DIRECTORY = join(".sovereign", "handoffs");
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_STATUS_ENTRIES = 200;
const MAX_RECENT_COMMITS = 8;
const MAX_WORKTREES = 16;
const MAX_LIST_ITEMS = 32;
const MAX_VALIDATION_ITEMS = 32;

const ROOT_KEYS = new Set([
  "schemaVersion",
  "sessionRole",
  "reason",
  "task",
  "continuation",
]);
const CONTINUATION_KEYS = new Set(["epoch", "previousAnchorId"]);
const CONTINUATION_ANCHOR_KEYS = new Set([
  "schemaVersion",
  "anchorId",
  "taskId",
  "epoch",
  "previousAnchorId",
  "generatedAt",
  "repositoryRoot",
  "branch",
  "head",
  "inputDigest",
  "bodyDigest",
]);
const TASK_KEYS = new Set([
  "id",
  "title",
  "goal",
  "currentStep",
  "completed",
  "remaining",
  "decisions",
  "limitations",
  "openQuestions",
  "validation",
]);
const VALIDATION_KEYS = new Set(["name", "status", "summary"]);
const SESSION_ROLES = new Set(["main", "support"]);
const HANDOFF_REASONS = new Set([
  "context-limit",
  "connection-stop",
  "compaction",
  "manual",
]);
const VALIDATION_STATUSES = new Set(["passed", "failed", "blocked", "not-run"]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/iu,
];

const PRIVATE_REASONING_PATTERNS = [
  /\bchain[- ]of[- ]thought\b/iu,
  /\bhidden reasoning\b/iu,
  /\bprivate reasoning\b/iu,
  /\bprivate scratchpad\b/iu,
];

function portablePath(value) {
  return value.split(sep).join("/");
}

function isContained(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function isVolumeRoot(value) {
  const normalized = resolve(value);
  return normalized === resolve(parse(normalized).root);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label} contains an unknown field: ${key}`);
  }
}

function normalizeText(value, label, maximumLength, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (required && normalized.length === 0)
    throw new Error(`${label} may not be empty.`);
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds its ${maximumLength}-character limit.`);
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(normalized))
      throw new Error(`${label} appears to contain credential material.`);
  }
  for (const pattern of PRIVATE_REASONING_PATTERNS) {
    if (pattern.test(normalized))
      throw new Error(
        `${label} appears to contain private reasoning or scratchpad content.`,
      );
  }
  return normalized;
}

function normalizeIdentifier(value, label, maximumLength = 128) {
  const normalized = normalizeText(value, label, maximumLength, {
    required: false,
  });
  if (normalized === null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return normalized;
}

function normalizeSha256(value, label, { required = true } = {}) {
  const normalized = normalizeText(value, label, 64, { required });
  if (normalized === null) return null;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function normalizeContinuation(value, taskId) {
  if (value === undefined) return null;
  const continuation = plainObject(value, "Session continuation");
  closedKeys(continuation, CONTINUATION_KEYS, "Session continuation");
  if (taskId === null) {
    throw new Error("Session continuation requires a Task ID.");
  }
  if (
    !Number.isSafeInteger(continuation.epoch) ||
    continuation.epoch < 1 ||
    continuation.epoch > 1_000_000
  ) {
    throw new Error(
      "Session continuation epoch must be an integer between 1 and 1000000.",
    );
  }
  const previousAnchorId = normalizeSha256(
    continuation.previousAnchorId,
    "Previous continuation anchor ID",
    { required: false },
  );
  if (continuation.epoch === 1 && previousAnchorId !== null) {
    throw new Error(
      "The first session continuation epoch may not name a previous anchor.",
    );
  }
  if (continuation.epoch > 1 && previousAnchorId === null) {
    throw new Error(
      "A later session continuation epoch requires the previous anchor ID.",
    );
  }
  return {
    epoch: continuation.epoch,
    previousAnchorId,
  };
}

function normalizeList(value, label, maximumItems = MAX_LIST_ITEMS) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > maximumItems)
    throw new Error(`${label} exceeds its ${maximumItems}-item limit.`);
  return value.map((entry, index) =>
    normalizeText(entry, `${label}[${index}]`, 800),
  );
}

function normalizeValidation(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("Task validation must be an array.");
  if (value.length > MAX_VALIDATION_ITEMS) {
    throw new Error(
      `Task validation exceeds its ${MAX_VALIDATION_ITEMS}-item limit.`,
    );
  }
  return value.map((rawEntry, index) => {
    const entry = plainObject(rawEntry, `Task validation[${index}]`);
    closedKeys(entry, VALIDATION_KEYS, `Task validation[${index}]`);
    const status = normalizeText(
      entry.status,
      `Task validation[${index}].status`,
      32,
    );
    if (!VALIDATION_STATUSES.has(status)) {
      throw new Error(
        `Task validation[${index}].status is unsupported: ${status}`,
      );
    }
    return {
      name: normalizeText(entry.name, `Task validation[${index}].name`, 200),
      status,
      summary: normalizeText(
        entry.summary,
        `Task validation[${index}].summary`,
        500,
        {
          required: false,
        },
      ),
    };
  });
}

export function validateHandoffInput(document) {
  const root = plainObject(document, "Session handoff input");
  closedKeys(root, ROOT_KEYS, "Session handoff input");
  if (root.schemaVersion !== INPUT_SCHEMA_VERSION) {
    throw new Error(`Session handoff schema must be ${INPUT_SCHEMA_VERSION}.`);
  }
  const role =
    root.sessionRole === undefined
      ? "main"
      : normalizeText(root.sessionRole, "Session role", 32);
  if (!SESSION_ROLES.has(role))
    throw new Error(`Unsupported session role: ${role}`);
  const reason =
    root.reason === undefined
      ? "context-limit"
      : normalizeText(root.reason, "Handoff reason", 64);
  if (!HANDOFF_REASONS.has(reason))
    throw new Error(`Unsupported handoff reason: ${reason}`);

  const task = plainObject(root.task, "Session handoff task");
  closedKeys(task, TASK_KEYS, "Session handoff task");
  const normalizedTask = {
    id: normalizeIdentifier(task.id, "Task ID"),
    title: normalizeText(task.title, "Task title", 200),
    goal: normalizeText(task.goal, "Task goal", 2_000),
    currentStep: normalizeText(task.currentStep, "Current step", 1_000),
    completed: normalizeList(task.completed, "Completed work"),
    remaining: normalizeList(task.remaining, "Remaining work"),
    decisions: normalizeList(task.decisions, "Decisions", 24),
    limitations: normalizeList(task.limitations, "Known limitations", 24),
    openQuestions: normalizeList(task.openQuestions, "Open questions", 24),
    validation: normalizeValidation(task.validation),
  };
  return {
    schemaVersion: INPUT_SCHEMA_VERSION,
    sessionRole: role,
    reason,
    task: normalizedTask,
    continuation: normalizeContinuation(root.continuation, normalizedTask.id),
  };
}

function runGit(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding,
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = String(
      result.stderr || result.stdout || "git command failed",
    ).trim();
    throw new Error(`Git evidence collection failed: ${detail}`);
  }
  return result;
}

function redactEvidenceText(value, patterns) {
  let redacted = value;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    redacted = redacted.replace(
      new RegExp(pattern.source, flags),
      "[REDACTED]",
    );
  }
  return redacted;
}

function safeEvidenceText(value, maximumLength) {
  let normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  normalized = redactEvidenceText(normalized, SECRET_PATTERNS);
  normalized = redactEvidenceText(normalized, PRIVATE_REASONING_PATTERNS);
  if (normalized.length > maximumLength)
    normalized = `${normalized.slice(0, maximumLength - 1)}…`;
  return normalized;
}

function parseWorktrees(raw) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current !== null) entries.push(current);
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
      current = {
        path: value,
        branch: null,
        head: null,
        detached: false,
        locked: false,
      };
    } else if (current !== null && key === "branch") {
      current.branch = String(value).replace(/^refs\/heads\//u, "");
    } else if (current !== null && key === "HEAD") {
      current.head = String(value);
    } else if (current !== null && key === "detached") {
      current.detached = true;
    } else if (current !== null && key === "locked") {
      current.locked = true;
    }
  }
  flush();
  return entries.slice(0, MAX_WORKTREES).map((entry) => ({
    path: portablePath(resolve(entry.path)),
    branch: entry.branch === null ? null : safeEvidenceText(entry.branch, 240),
    head: entry.head,
    detached: entry.detached,
    locked: entry.locked,
  }));
}

export async function collectGitEvidence(root) {
  const absoluteRoot = resolve(root);
  if (isVolumeRoot(absoluteRoot))
    throw new Error(
      "Refusing to collect handoff evidence from a filesystem or volume root.",
    );
  const metadata = await lstat(absoluteRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "Session handoff root must be a direct directory, not a link or junction.",
    );
  }
  const canonicalRoot = await realpath(absoluteRoot);
  if (isVolumeRoot(canonicalRoot))
    throw new Error("Refusing a canonical filesystem or volume root.");
  const topLevel = runGit(absoluteRoot, ["rev-parse", "--show-toplevel"]);
  const reportedRoot = resolve(String(topLevel.stdout).trim());
  if (reportedRoot.toLowerCase() !== absoluteRoot.toLowerCase()) {
    throw new Error(
      "Session handoff must run from the exact Git worktree root.",
    );
  }

  const branch = String(
    runGit(absoluteRoot, ["branch", "--show-current"]).stdout,
  ).trim();
  const head = String(
    runGit(absoluteRoot, ["rev-parse", "HEAD"]).stdout,
  ).trim();
  const subject = safeEvidenceText(
    String(runGit(absoluteRoot, ["show", "-s", "--format=%s", "HEAD"]).stdout),
    300,
  );
  const commonDir = resolve(
    String(
      runGit(absoluteRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).stdout,
    ).trim(),
  );
  const statusLines = String(
    runGit(absoluteRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
      .stdout,
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  const statusTruncated = statusLines.length > MAX_STATUS_ENTRIES;
  const status = statusLines.slice(0, MAX_STATUS_ENTRIES).map((line) => {
    const code = line.length >= 2 ? line.slice(0, 2) : "??";
    const rawPath = line.length > 3 ? line.slice(3) : line.slice(2);
    return `${code} ${safeEvidenceText(rawPath, 1_020)}`;
  });

  const commitOutput = String(
    runGit(absoluteRoot, [
      "log",
      `-${MAX_RECENT_COMMITS}`,
      "--format=%H%x1f%aI%x1f%s%x1e",
    ]).stdout,
  );
  const recentCommits = commitOutput
    .split("\u001e")
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [commit, authoredAt, ...subjectParts] = record.split("\u001f");
      return {
        commit: commit.trim(),
        authoredAt: safeEvidenceText(authoredAt, 64),
        subject: safeEvidenceText(subjectParts.join("\u001f"), 300),
      };
    });

  const worktrees = parseWorktrees(
    String(runGit(absoluteRoot, ["worktree", "list", "--porcelain"]).stdout),
  );
  const currentNormalized = portablePath(absoluteRoot).toLowerCase();
  const currentWorktree =
    worktrees.find((entry) => entry.path.toLowerCase() === currentNormalized) ??
    null;

  return {
    repositoryRoot: portablePath(absoluteRoot),
    commonGitDirectory: portablePath(commonDir),
    worktreeName: basename(absoluteRoot),
    branch: branch.length === 0 ? null : safeEvidenceText(branch, 240),
    detached: branch.length === 0,
    head,
    headSubject: subject,
    dirty: status.length > 0,
    status,
    statusTruncated,
    recentCommits,
    registeredWorktreeCount: worktrees.length,
    worktrees,
    currentWorktree,
  };
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function continuationAnchorPayload(anchor) {
  return {
    schemaVersion: CONTINUATION_ANCHOR_SCHEMA_VERSION,
    taskId: anchor.taskId,
    epoch: anchor.epoch,
    previousAnchorId: anchor.previousAnchorId,
    generatedAt: anchor.generatedAt,
    repositoryRoot: anchor.repositoryRoot,
    branch: anchor.branch,
    head: anchor.head,
    inputDigest: anchor.inputDigest,
    bodyDigest: anchor.bodyDigest,
  };
}

function renderContinuationPrelude(input) {
  if (input.continuation === null) return "";
  const previous =
    input.continuation.previousAnchorId === null
      ? "none (first epoch)"
      : input.continuation.previousAnchorId;
  return [
    "## Continuation correlation",
    "",
    `- Epoch: ${inlineCode(String(input.continuation.epoch))}`,
    `- Previous anchor: ${inlineCode(previous)}`,
    "- Binding scope: Task ID, exact Git worktree identity, normalized handoff input, and this file body.",
    "",
    "This public correlation evidence is not a capability token, browser lease, conversation transcript, or authority grant. A replacement session must still revalidate the current Task owner, MCP session, permissions, tool manifest, and Git state.",
    "",
  ].join("\n");
}

function buildContinuationAnchor(
  input,
  evidence,
  generatedAt,
  inputDigest,
  body,
) {
  if (input.continuation === null) return null;
  const payload = continuationAnchorPayload({
    taskId: input.task.id,
    epoch: input.continuation.epoch,
    previousAnchorId: input.continuation.previousAnchorId,
    generatedAt,
    repositoryRoot: evidence.repositoryRoot,
    branch: evidence.branch,
    head: evidence.head,
    inputDigest,
    bodyDigest: sha256Text(body),
  });
  return {
    schemaVersion: CONTINUATION_ANCHOR_SCHEMA_VERSION,
    anchorId: sha256Text(JSON.stringify(payload)),
    ...payload,
  };
}

function renderContinuationAnchorMarker(anchor) {
  if (anchor === null) return "";
  return `<!-- ${CONTINUATION_ANCHOR_MARKER}\n${JSON.stringify(anchor)}\n-->\n`;
}

function validateContinuationAnchorDocument(document) {
  const anchor = plainObject(document, "Session continuation anchor");
  closedKeys(anchor, CONTINUATION_ANCHOR_KEYS, "Session continuation anchor");
  if (anchor.schemaVersion !== CONTINUATION_ANCHOR_SCHEMA_VERSION) {
    throw new Error(
      `Session continuation anchor schema must be ${CONTINUATION_ANCHOR_SCHEMA_VERSION}.`,
    );
  }
  const taskId = normalizeIdentifier(anchor.taskId, "Continuation Task ID");
  if (taskId === null) throw new Error("Continuation Task ID is required.");
  const continuation = normalizeContinuation(
    {
      epoch: anchor.epoch,
      previousAnchorId: anchor.previousAnchorId,
    },
    taskId,
  );
  const generatedAt = normalizeText(
    anchor.generatedAt,
    "Continuation generation time",
    64,
  );
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Continuation generation time is invalid.");
  }
  const repositoryRoot = normalizeText(
    anchor.repositoryRoot,
    "Continuation repository root",
    4_096,
  );
  const branch = normalizeText(anchor.branch, "Continuation branch", 240, {
    required: false,
  });
  const head = normalizeText(anchor.head, "Continuation Git HEAD", 64);
  if (!/^[a-f0-9]{40,64}$/u.test(head)) {
    throw new Error("Continuation Git HEAD is invalid.");
  }
  const normalized = {
    schemaVersion: CONTINUATION_ANCHOR_SCHEMA_VERSION,
    taskId,
    epoch: continuation.epoch,
    previousAnchorId: continuation.previousAnchorId,
    generatedAt,
    repositoryRoot,
    branch,
    head,
    inputDigest: normalizeSha256(
      anchor.inputDigest,
      "Continuation input digest",
    ),
    bodyDigest: normalizeSha256(anchor.bodyDigest, "Continuation body digest"),
  };
  return {
    anchorId: normalizeSha256(anchor.anchorId, "Continuation anchor ID"),
    ...normalized,
  };
}

export function verifySessionContinuationAnchor(markdown, expected = {}) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new Error("Session handoff Markdown is required.");
  }
  const marker = `<!-- ${CONTINUATION_ANCHOR_MARKER}\n`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Session handoff has no continuation anchor.");
  }
  if (markdown.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error("Session handoff has multiple continuation anchors.");
  }
  const suffix = "\n-->\n";
  const markerEnd = markdown.indexOf(suffix, markerIndex + marker.length);
  if (markerEnd < 0 || markerEnd + suffix.length !== markdown.length) {
    throw new Error(
      "Session continuation anchor must terminate the handoff file.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(markdown.slice(markerIndex + marker.length, markerEnd));
  } catch (error) {
    throw new Error(
      `Session continuation anchor is invalid JSON: ${error.message}`,
    );
  }
  const anchor = validateContinuationAnchorDocument(parsed);
  const body = markdown.slice(0, markerIndex);
  if (anchor.bodyDigest !== sha256Text(body)) {
    throw new Error("Session continuation handoff body digest does not match.");
  }
  const expectedAnchorId = sha256Text(
    JSON.stringify(continuationAnchorPayload(anchor)),
  );
  if (anchor.anchorId !== expectedAnchorId) {
    throw new Error("Session continuation anchor digest does not match.");
  }
  for (const key of [
    "taskId",
    "epoch",
    "previousAnchorId",
    "repositoryRoot",
    "branch",
    "head",
    "inputDigest",
  ]) {
    if (expected[key] !== undefined && anchor[key] !== expected[key]) {
      throw new Error(`Session continuation anchor ${key} does not match.`);
    }
  }
  return anchor;
}

function markdownText(value) {
  return String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/([*_<>])/gu, "\\$1");
}

function inlineCode(value) {
  return `\`${String(value).replace(/`/gu, "ˋ")}\``;
}

function renderList(items, emptyText) {
  if (items.length === 0) return `- ${emptyText}\n`;
  return `${items.map((item) => `- ${markdownText(item)}`).join("\n")}\n`;
}

function renderValidation(items) {
  if (items.length === 0)
    return "- No validation result was supplied. Re-run the checks required by the current workspace.\n";
  const lines = ["| Check | Status | Summary |", "| --- | --- | --- |"];
  for (const item of items) {
    const summary = item.summary === null ? "" : item.summary;
    lines.push(
      `| ${item.name.replace(/\|/gu, "\\|")} | ${item.status} | ${summary.replace(/\|/gu, "\\|")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderHandoff(input, evidence, generatedAt, inputDigest) {
  const taskId =
    input.task.id === null ? "Not supplied" : inlineCode(input.task.id);
  const branch =
    evidence.branch === null ? "detached" : inlineCode(evidence.branch);
  const currentWorktree =
    evidence.currentWorktree?.path ?? evidence.repositoryRoot;
  const lines = [
    `# Session handoff — ${markdownText(input.task.title)}`,
    "",
    `> ${OUTPUT_SCHEMA_VERSION}. This file is bounded recovery evidence, not authority and not a conversation transcript.`,
    "",
    "## Handoff identity",
    "",
    `- Generated: ${inlineCode(generatedAt)}`,
    `- Session role: ${inlineCode(input.sessionRole)}`,
    `- Reason: ${inlineCode(input.reason)}`,
    `- Task ID: ${taskId}`,
    `- Input SHA-256: ${inlineCode(inputDigest)}`,
    "",
    "## Goal",
    "",
    markdownText(input.task.goal),
    "",
    "## Current step",
    "",
    markdownText(input.task.currentStep),
    "",
    "## Completed",
    "",
    renderList(input.task.completed, "No completed item was supplied."),
    "## Remaining",
    "",
    renderList(
      input.task.remaining,
      "No remaining item was supplied; verify before treating the task as complete.",
    ),
    "## Decisions",
    "",
    renderList(input.task.decisions, "No durable decision was supplied."),
    "## Known limitations",
    "",
    renderList(input.task.limitations, "No known limitation was supplied."),
    "## Open questions",
    "",
    renderList(input.task.openQuestions, "No open question was supplied."),
    "## Validation",
    "",
    renderValidation(input.task.validation),
    "## Git evidence at handoff time",
    "",
    `- Repository root: ${inlineCode(evidence.repositoryRoot)}`,
    `- Current worktree: ${inlineCode(currentWorktree)}`,
    `- Branch: ${branch}`,
    `- HEAD: ${inlineCode(evidence.head)}`,
    `- HEAD subject: ${markdownText(evidence.headSubject)}`,
    `- Working tree dirty: ${inlineCode(String(evidence.dirty))}`,
    `- Registered worktrees captured: ${inlineCode(String(evidence.registeredWorktreeCount))}`,
    "",
    "### Working-tree status",
    "",
  ];
  if (evidence.status.length === 0) lines.push("- Clean");
  else
    for (const entry of evidence.status) lines.push(`- ${inlineCode(entry)}`);
  if (evidence.statusTruncated)
    lines.push(`- Status was truncated after ${MAX_STATUS_ENTRIES} entries.`);

  lines.push("", "### Recent commits", "");
  if (evidence.recentCommits.length === 0)
    lines.push("- No commit evidence was available.");
  else {
    for (const commit of evidence.recentCommits) {
      lines.push(
        `- ${inlineCode(commit.commit)} — ${markdownText(commit.subject)} (${inlineCode(commit.authoredAt)})`,
      );
    }
  }

  lines.push("", "### Registered worktrees", "");
  if (evidence.worktrees.length === 0)
    lines.push("- No worktree evidence was available.");
  else {
    for (const worktree of evidence.worktrees) {
      const worktreeBranch =
        worktree.branch === null ? "detached" : worktree.branch;
      const qualifiers = [
        worktree.detached ? "detached" : null,
        worktree.locked ? "locked" : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- ${inlineCode(worktree.path)} — ${inlineCode(worktreeBranch)} @ ${inlineCode(worktree.head ?? "unknown")}${qualifiers.length === 0 ? "" : ` (${qualifiers})`}`,
      );
    }
  }

  lines.push(
    "",
    "## Resume protocol",
    "",
    "1. Re-read the current user request; a restored message may be stale or replayed.",
    "2. Re-run Git identity and status checks. Do not act on this file if the root, branch, HEAD, or dirty set has materially changed without reconciling the change.",
    "3. Read the Sovereign Tasks inbox and the task identified above when available; task state may be newer than this file.",
    "4. Inspect the relevant source and tests instead of trusting summaries as proof.",
    "5. Continue the smallest remaining end-to-end step. Preserve unrelated dirty files and active worktrees.",
    "6. Update or supersede this handoff after verified progress; never append transcripts, command output, credentials, or private reasoning.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug.length === 0 ? "task" : slug;
}

function timestampSlug(date) {
  return date.toISOString().replace(/[-:.]/gu, "").replace("T", "-");
}

async function ensureDirectDirectory(root, relativeDirectory) {
  let current = root;
  for (const segment of relativeDirectory.split(/[\\/]/u)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(
          `Handoff directory component is not a direct directory: ${portablePath(relative(root, current))}`,
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const canonical = await realpath(current);
    if (!isContained(root, canonical))
      throw new Error("Handoff directory escaped the workspace root.");
  }
  return current;
}

function normalizeOutputPath(root, output, input, evidence, generatedAt) {
  const directory = resolve(root, HANDOFF_DIRECTORY);
  if (output === "auto" || output === null || output === undefined) {
    const filename = [
      "handoff",
      timestampSlug(new Date(generatedAt)),
      evidence.head.slice(0, 12),
      slugify(input.task.title),
    ].join("-");
    return join(directory, `${filename}.md`);
  }
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    output.length > 1_024
  ) {
    throw new Error("Session handoff output must be 'auto' or a bounded path.");
  }
  if (isAbsolute(output))
    throw new Error("Session handoff output must be workspace-relative.");
  const candidate = resolve(root, output);
  if (!isContained(directory, candidate) || candidate === directory) {
    throw new Error(
      `Session handoff output must be a Markdown file inside ${portablePath(HANDOFF_DIRECTORY)}.`,
    );
  }
  if (!candidate.toLowerCase().endsWith(".md")) {
    throw new Error("Session handoff output must use the .md extension.");
  }
  return candidate;
}

export async function createSessionHandoff({ root, input, output = "auto" }) {
  const normalizedInput = validateHandoffInput(input);
  const evidence = await collectGitEvidence(root);
  const generatedAt = new Date().toISOString();
  const { continuation, ...legacyInput } = normalizedInput;
  const canonicalInput = JSON.stringify(
    continuation === null ? legacyInput : normalizedInput,
  );
  const inputDigest = sha256Text(canonicalInput);
  const body = `${renderHandoff(
    normalizedInput,
    evidence,
    generatedAt,
    inputDigest,
  )}${renderContinuationPrelude(normalizedInput)}`;
  const continuationAnchor = buildContinuationAnchor(
    normalizedInput,
    evidence,
    generatedAt,
    inputDigest,
    body,
  );
  const markdown = `${body}${renderContinuationAnchorMarker(continuationAnchor)}`;
  const absoluteRoot = resolve(root);
  const outputPath = normalizeOutputPath(
    absoluteRoot,
    output,
    normalizedInput,
    evidence,
    generatedAt,
  );
  const handoffDirectory = await ensureDirectDirectory(
    absoluteRoot,
    HANDOFF_DIRECTORY,
  );
  const canonicalDirectory = await realpath(handoffDirectory);
  const outputParent = resolve(dirname(outputPath));
  if (!isContained(canonicalDirectory, outputParent)) {
    throw new Error(
      "Session handoff output parent escaped the handoff directory.",
    );
  }
  if (outputParent !== handoffDirectory) {
    const nestedRelative = relative(handoffDirectory, outputParent);
    await ensureDirectDirectory(handoffDirectory, nestedRelative);
  }
  await writeFile(outputPath, markdown, { encoding: "utf8", flag: "wx" });
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    generatedAt,
    outputPath,
    relativeOutputPath: portablePath(relative(absoluteRoot, outputPath)),
    inputDigest,
    continuationAnchor,
    git: evidence,
  };
}

async function readBoundedInputFile(root, inputPath) {
  if (
    typeof inputPath !== "string" ||
    inputPath.length === 0 ||
    inputPath.length > 1_024
  ) {
    throw new Error("Session handoff input path must be bounded.");
  }
  if (isAbsolute(inputPath))
    throw new Error("Session handoff input path must be workspace-relative.");
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, inputPath);
  if (!isContained(absoluteRoot, candidate) || candidate === absoluteRoot) {
    throw new Error("Session handoff input path escaped the workspace root.");
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Session handoff input must be a direct regular file.");
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const canonicalCandidate = await realpath(candidate);
  if (
    !isContained(canonicalRoot, canonicalCandidate) ||
    canonicalCandidate === canonicalRoot
  ) {
    throw new Error(
      "Session handoff input path escaped the canonical workspace root.",
    );
  }
  if (metadata.size < 2 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(
      `Session handoff input must be between 2 and ${MAX_INPUT_BYTES} bytes.`,
    );
  }
  return readFile(canonicalCandidate, "utf8");
}

async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error(
        `Session handoff stdin exceeds ${MAX_INPUT_BYTES} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  if (bytes < 2) throw new Error("Session handoff stdin is empty.");
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

export function parseCliArguments(argv) {
  const values = { root: null, input: null, stdin: false, output: "auto" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--stdin") {
      if (values.stdin)
        throw new Error("Session handoff --stdin flag is duplicated.");
      values.stdin = true;
      continue;
    }
    if (flag !== "--root" && flag !== "--input" && flag !== "--output") {
      throw new Error(`Unknown session handoff argument: ${String(flag)}`);
    }
    const argument = argv[index + 1];
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.startsWith("--")
    ) {
      throw new Error(`Session handoff argument has no value: ${flag}`);
    }
    index += 1;
    if (flag === "--root") values.root = argument;
    else if (flag === "--input") values.input = argument;
    else values.output = argument;
  }
  if (values.root === null)
    throw new Error("Missing session handoff argument: --root");
  if (values.stdin === (values.input !== null)) {
    throw new Error(
      "Choose exactly one session handoff input source: --stdin or --input.",
    );
  }
  return values;
}

export async function runSessionHandoffCli(argv) {
  const options = parseCliArguments(argv);
  const root = resolve(options.root);
  const raw = options.stdin
    ? await readBoundedStdin()
    : await readBoundedInputFile(root, options.input);
  const result = await createSessionHandoff({
    root,
    input: parseJson(raw, "Session handoff input"),
    output: options.output,
  });
  process.stdout.write(`${result.relativeOutputPath}\n`);
  return result;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runSessionHandoffCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Session handoff failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
