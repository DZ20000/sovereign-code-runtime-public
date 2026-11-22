#!/usr/bin/env node
/** Read-only release-boundary checks. Findings never include matched content. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";

const MAX_BYTES = 64 * 1024 * 1024;
const PLACEHOLDER = /example|placeholder|redacted|dummy|fixture|fake|(?:^|[-_])test(?:[-_]|$)|replace[-_]?me|change[-_]?me|your[-_]|must[-_]not[-_](?:be[-_])?(?:copied|leak)|^VALUE_[A-Z0-9_]+$/i;
const USERS = new Set(["alice", "bob", "user", "username", "test", "tester", "test-user", "developer", "dev", "runner", "runneradmin", "public", "default", "fixture", "owner", "me", "someone", "x"]);
const CREDENTIALS = [
  /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,255}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/g,
];

function finding(rule, file, line) {
  return { rule, path: file, ...(line === undefined ? {} : { line }) };
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
}

function globMatch(file, glob) {
  const expression = glob.split("**").map(part => part.split("*").map(
    value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("[^/]*")).join(".*");
  return new RegExp(`^${expression}$`, "i").test(file);
}

export function scanPath(file, { denyPaths = [], denyTerms = [] } = {}) {
  const normalized = file.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const result = [];
  if (denyTerms.some(term => term && normalized.toLowerCase().includes(term.replaceAll("\\", "/").toLowerCase()))) {
    result.push(finding("custom-private-binding", file));
  }
  if (parts.includes("..") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    result.push(finding("unsafe-archive-path", file));
  }
  if (parts.some(part => [".git", ".sovereign", ".worktrees", "profiles", "browser-profiles"].includes(part.toLowerCase()))) {
    result.push(finding("private-runtime-directory", file));
  }
  const name = parts.at(-1).toLowerCase();
  if ((/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))
      || /^(?:credentials|cookies|secrets|tokens)\.(?:json|ya?ml|toml|txt)$/.test(name)
      || /^(?:id_rsa|id_ed25519|\.pypirc)$/.test(name)
      || /\.(?:pfx|p12|keystore|log|sqlite3?|db)$/.test(name)) {
    result.push(finding("private-state-or-credential-file", file));
  }
  if (denyPaths.some(glob => globMatch(normalized, glob))) result.push(finding("custom-excluded-path", file));
  return result;
}

export function scanText(file, text, { denyTerms = [] } = {}) {
  const result = [];
  const terms = denyTerms.filter(Boolean).map(term => term.toLowerCase());
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const rules = new Set();
    if (terms.some(term => line.toLowerCase().includes(term))) rules.add("custom-private-binding");
    if (/\b(?:LAPTOP|DESKTOP)-[A-Z0-9]{4,}\b/.test(line)) rules.add("machine-name");
    for (const match of line.matchAll(/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)([^\\/\s"'<>`]+)/g)) {
      if (!USERS.has(match[1].toLowerCase()) && !PLACEHOLDER.test(match[1])) rules.add("personal-home-path");
    }
    for (const pattern of CREDENTIALS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        if (!PLACEHOLDER.test(match[0]) && entropy(match[0]) >= 3.2) rules.add("credential-token");
      }
    }
    if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(line)) rules.add("private-key");
    const assignments = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi;
    for (const match of line.matchAll(assignments)) {
      if (!PLACEHOLDER.test(match[1]) && !/[${}]/.test(match[1]) && entropy(match[1]) >= 3.5) rules.add("credential-assignment");
    }
    if (path.basename(file).toLowerCase() === ".npmrc") {
      const match = /^\s*(?:[^=]*:)?(?:_authToken|_auth|_password|password|username)\s*=\s*(.+?)\s*$/i.exec(line);
      if (match && !PLACEHOLDER.test(match[1]) && !/[${}]/.test(match[1])) rules.add("registry-credential");
    }
    for (const rule of rules) result.push(finding(rule, file, index + 1));
  }
  return result;
}

function scanBuffer(file, buffer, options) {
  const result = scanPath(file, options);
  if (buffer.length > (options.maxBytes || MAX_BYTES)) return [...result, finding("scan-size-limit", file)];
  result.push(...scanText(file, buffer.toString("utf8"), options));
  // Also inspect native binaries/resources whose strings use UTF-16LE.
  if (buffer.includes(0)) {
    result.push(...scanText(file, buffer.toString("utf16le"), options));
    // Embedded resource strings need not begin at an even file offset.
    result.push(...scanText(file, buffer.subarray(1).toString("utf16le"), options));
  }
  return result;
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], { encoding, maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function scanRepository(root, options = {}) {
  const files = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
  const findings = [];
  const canonicalRoot = realpathSync(root);
  let checkedFiles = 0;
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(path.resolve(root), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      findings.push(finding("unsafe-source-path", file));
      continue;
    }
    let stat;
    try { stat = lstatSync(absolute); } catch (error) {
      if (error.code === "ENOENT") continue; // A tracked file deleted in the pending change.
      throw error;
    }
    const canonicalRelative = path.relative(canonicalRoot, realpathSync(absolute));
    if (stat.isSymbolicLink() || canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
      findings.push(finding("source-symlink-not-inspected", file));
      continue;
    }
    if (!stat.isFile()) continue;
    checkedFiles += 1;
    if (stat.size > (options.maxBytes || MAX_BYTES)) findings.push(finding("scan-size-limit", file));
    else findings.push(...scanBuffer(file, readFileSync(absolute), options));
  }
  return { checkedFiles, findings };
}

export function scanHistory(root, range, options = {}) {
  if (!range || range.startsWith("-")) throw new Error("Invalid history range");
  const commits = git(root, ["rev-list", "--reverse", range, "--"]).trim().split("\n").filter(Boolean);
  const findings = [];
  const checked = new Set();
  for (const commit of commits) {
    findings.push(...scanText(`history/${commit}/commit`, git(root, ["cat-file", "commit", commit]), options));
    const changedPaths = new Set(git(root, ["diff-tree", "--root", "-m", "-r", "--no-commit-id", "--name-only", "-z", commit]).split("\0").filter(Boolean));
    const entries = git(root, ["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean);
    for (const entry of entries) {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, mode, oid, file] = match;
      if (!changedPaths.has(file)) continue;
      const key = `${oid}:${file}`;
      if (checked.has(key)) continue;
      checked.add(key);
      if (mode === "120000") findings.push(finding("history-symlink-not-inspected", file));
      else {
        const size = Number(git(root, ["cat-file", "-s", oid]));
        const hits = size > (options.maxBytes || MAX_BYTES)
          ? [finding("scan-size-limit", file)]
          : scanBuffer(file, git(root, ["cat-file", "blob", oid], null), options);
        findings.push(...hits.map(hit => ({ ...hit, commit })));
      }
    }
  }
  return { checkedCommits: commits.length, checkedBlobs: checked.size, findings };
}

export function scanZip(buffer, options = {}, depth = 0) {
  const findings = [];
  const entries = [];
  const maxBytes = options.maxBytes || MAX_BYTES;
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw new Error("Invalid ZIP directory");
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error("Split ZIP not supported");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 8) !== count || offset + buffer.readUInt32LE(end + 12) > end) throw new Error("Invalid ZIP directory bounds");
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 needs a dedicated archive scanner");
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const packedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const file = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    findings.push(...scanPath(file, options));
    if (file.endsWith("/")) continue;
    total += size;
    if (flags & 1 || ![0, 8].includes(method) || size > maxBytes || total > 4 * maxBytes || ((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      findings.push(finding("archive-entry-not-inspected", file));
      continue;
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local header");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localName !== file || buffer.readUInt16LE(localOffset + 8) !== method || buffer.readUInt16LE(localOffset + 6) !== flags) throw new Error("ZIP headers disagree");
    const start = localOffset + 30 + localNameLength + buffer.readUInt16LE(localOffset + 28);
    if (start + packedSize > buffer.length) throw new Error("Truncated ZIP entry");
    const packed = buffer.subarray(start, start + packedSize);
    const data = method === 8 ? inflateRawSync(packed, { maxOutputLength: maxBytes }) : packed;
    if (data.length !== size) throw new Error("ZIP size mismatch");
    entries.push(file);
    findings.push(...scanBuffer(file, data, options));
    if (/\.(?:zip|jar|docx|xlsx|pptx)$/i.test(file)) {
      if (depth >= 2) findings.push(finding("nested-archive-depth-limit", file));
      else {
        const nested = scanZip(data, options, depth + 1);
        findings.push(...nested.findings.map(hit => ({ ...hit, path: `${file}!/${hit.path}` })));
      }
    }
  }
  return { checkedEntries: entries.length, findings };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    root: { type: "string", default: process.cwd() },
    history: { type: "string" },
    zip: { type: "string", multiple: true, default: [] },
    "deny-term": { type: "string", multiple: true, default: [] },
    "deny-path": { type: "string", multiple: true, default: [] },
    "max-bytes": { type: "string" },
  } });
  const maxBytes = values["max-bytes"] === undefined ? MAX_BYTES : Number(values["max-bytes"]);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid scan limit");
  const options = { denyTerms: values["deny-term"], denyPaths: values["deny-path"], maxBytes };
  const source = scanRepository(path.resolve(values.root), options);
  const history = values.history ? scanHistory(path.resolve(values.root), values.history, options) : null;
  const archives = values.zip.map(file => {
    const buffer = readFileSync(file);
    return { archive: path.basename(file), sha256: createHash("sha256").update(buffer).digest("hex"), ...scanZip(buffer, options) };
  });
  const findings = [...source.findings, ...(history?.findings || []), ...archives.flatMap(archive => archive.findings.map(hit => ({ ...hit, archive: archive.archive })))];
  const unique = [...new Map(findings.map(hit => [JSON.stringify(hit), hit])).values()];
  return {
    ok: unique.length === 0,
    checkedFiles: source.checkedFiles,
    checkedCommits: history?.checkedCommits || 0,
    checkedHistoryBlobs: history?.checkedBlobs || 0,
    archives: archives.map(({ findings: unused, ...metadata }) => metadata),
    customTermCount: options.denyTerms.length,
    customPathRuleCount: options.denyPaths.length,
    findings: unique,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = main();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    // Error text can contain local paths or sensitive process output.
    process.stdout.write(`${JSON.stringify({ ok: false, error: "scan-incomplete", kind: error.name })}\n`);
    process.exitCode = 2;
  }
}
