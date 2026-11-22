import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { scanHistory, scanPath, scanRepository, scanText, scanZip } from "./public-source-check.mjs";

function zipEntry(name, contents) {
  const filename = Buffer.from(name);
  const data = Buffer.from(contents);
  const packed = deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}

test("public placeholders and environment-based configuration are permitted", () => {
  assert.deepEqual(scanText("config.ts", 'const key = process.env.API_KEY;\nconst home = "C:\\\\Users\\\\test-user\\\\work";'), []);
  assert.deepEqual(scanPath(".env.example"), []);
  assert.deepEqual(scanText(".env.example", "API_KEY=replace-me"), []);
  assert.deepEqual(scanText("package.json", '{"name":"desktop-workspace"}'), []);
  assert.deepEqual(scanPath(".npmrc"), []);
  assert.deepEqual(scanText(".npmrc", "node-linker=hoisted"), []);
  assert.deepEqual(scanText(".npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}"), []);
  assert.ok(scanText(".npmrc", "//registry.npmjs.org/:_authToken=nonpublicvalue").some(hit => hit.rule === "registry-credential"));
  const machine = ["DESKTOP", "AB12CD3"].join("-");
  assert.ok(scanText("config.json", machine).some(hit => hit.rule === "machine-name"));
});

test("findings redact private content while identifying path and line", () => {
  const term = ["internal", "workspace", "fixture"].join("-");
  const credential = ["aB9cD8eF7gH6iJ5k", "L4mN3oP2qR1sT0uV"].join("");
  const text = `label=${term}\napi_key="${credential}"`;
  const findings = scanText("config.json", text, { denyTerms: [term] });
  assert.deepEqual(findings.map(hit => hit.rule), ["custom-private-binding", "credential-assignment"]);
  assert.deepEqual(findings.map(hit => hit.line), [1, 2]);
  assert.equal(JSON.stringify(findings).includes(term), false);
  assert.equal(JSON.stringify(findings).includes(credential), false);
  assert.ok(scanPath(`${term}/empty.txt`, { denyTerms: [term] }).some(hit => hit.rule === "custom-private-binding"));
  assert.ok(scanPath(".sovereign/state.json").some(hit => hit.rule === "private-runtime-directory"));
  assert.ok(scanPath("docs/private/notes.md", { denyPaths: ["docs/private/**"] }).length);
});

test("ZIP contents and path boundaries are inspected without extraction", () => {
  const term = ["internal", "fixture"].join("-");
  const result = scanZip(zipEntry("docs/note.md", term), { denyTerms: [term] });
  assert.equal(result.checkedEntries, 1);
  assert.equal(result.findings[0].rule, "custom-private-binding");
  assert.ok(scanZip(zipEntry("../escape.txt", "text")).findings.some(hit => hit.rule === "unsafe-archive-path"));
  assert.ok(scanZip(zipEntry(".git/config", "text")).findings.some(hit => hit.rule === "private-runtime-directory"));
  assert.ok(scanZip(zipEntry("large.txt", "123456789"), { maxBytes: 4 }).findings.some(hit => hit.rule === "archive-entry-not-inspected"));
  assert.throws(() => scanZip(Buffer.from("not an archive")));
});

test("binary strings are inspected in UTF-8 and both UTF-16LE alignments", () => {
  const term = ["internal", "binary", "fixture"].join("-");
  for (const encoding of ["utf8", "utf16le"]) {
    for (const prefix of [Buffer.alloc(0), Buffer.from([0x4d])]) {
      const binary = Buffer.concat([prefix, Buffer.from(term, encoding), Buffer.from([0])]);
      const result = scanZip(zipEntry("application.exe", binary), { denyTerms: [term] });
      assert.ok(result.findings.some(hit => hit.rule === "custom-private-binding"));
    }
  }
});

test("nested archives cannot hide a private file", () => {
  const nested = zipEntry(".env", "EXAMPLE=placeholder");
  const result = scanZip(zipEntry("resources.zip", nested));
  assert.ok(result.findings.some(hit => hit.path === "resources.zip!/.env" && hit.rule === "private-state-or-credential-file"));
});

test("history detects a removed binding and source scanning includes untracked additions", () => {
  const scratch = fileURLToPath(new URL("../.sovereign/scratch/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "public-source-check-test-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Public Source Check Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(path.join(root, "README.md"), "public source\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const term = ["internal", "private", "fixture"].join("-");
    writeFileSync(path.join(root, "README.md"), term);
    git("add", "."); git("commit", "-qm", "intermediate change");
    writeFileSync(path.join(root, "README.md"), "public source\n");
    git("add", "."); git("commit", "-qm", "remove binding");
    assert.deepEqual(scanRepository(root, { denyTerms: [term] }).findings, []);
    const history = scanHistory(root, `${base}..HEAD`, { denyTerms: [term] });
    assert.equal(history.checkedCommits, 2);
    assert.ok(history.findings.some(hit => hit.path === "README.md" && hit.commit));
    writeFileSync(path.join(root, "pending.md"), term);
    assert.ok(scanRepository(root, { denyTerms: [term] }).findings.some(hit => hit.path === "pending.md"));
  } finally {
    assert.equal(path.dirname(root), path.resolve(scratch));
    rmSync(root, { recursive: true, force: true });
  }
});
