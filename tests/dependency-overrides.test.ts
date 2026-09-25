import { fork } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const localRequire = createRequire(join(root, "package.json"));

function packageRoot(request: NodeJS.Require, name: string): string {
  let directory = dirname(realpathSync(request.resolve(name)));
  for (let depth = 0; depth < 12; depth += 1) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
      expect(directory.startsWith(join(root, "node_modules") + sep)).toBe(true);
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot locate installed package metadata for ${name}.`);
}

function packageVersion(directory: string): string {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version as string;
}

describe("scoped build dependency overrides", () => {
  it("runs Forge's real rebuild IPC worker on a dependency-free fixture", async () => {
    const core = packageRoot(localRequire, "@electron-forge/core-utils");
    const request = createRequire(join(core, "package.json"));
    expect(packageVersion(packageRoot(request, "@electron/rebuild"))).toBe("4.0.6");
    const fixture = await mkdtemp(join(tmpdir(), "scr-forge-compat-"));
    try {
      await writeFile(join(fixture, "package.json"), JSON.stringify({
        name: "source-compat-fixture", version: "1.0.0", private: true, dependencies: {},
      }));
      const electronVersion = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version;
      const messages: Array<{ msg?: string; err?: { message?: string } }> = [];
      await new Promise<void>((complete, fail) => {
        const child = fork(join(core, "dist/remote-rebuild.js"), [JSON.stringify({
          buildPath: fixture, electronVersion, arch: process.arch, onlyModules: [],
        })], { cwd: fixture, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        let output = "";
        const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8192); };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        const timer = setTimeout(() => { child.kill(); fail(new Error("Forge worker timed out.")); }, 15_000);
        child.on("message", message => { messages.push(message as typeof messages[number]); });
        child.once("error", error => { clearTimeout(timer); fail(error); });
        child.once("close", code => {
          clearTimeout(timer);
          const problem = messages.find(message => message.msg === "rebuild-error");
          if (code !== 0 || problem) fail(new Error(problem?.err?.message ?? `Forge worker exited ${code}: ${output}`));
          else complete();
        });
      });
      expect(messages.some(message => message.msg === "rebuild-done")).toBe(true);
      expect(messages.some(message => message.msg === "module-found")).toBe(false);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("preserves external-editor temporary-file API and cleanup without launching an editor", async () => {
    const directory = packageRoot(localRequire, "external-editor");
    const request = createRequire(join(directory, "package.json"));
    expect(packageVersion(packageRoot(request, "tmp"))).toBe("0.2.7");
    const { ExternalEditor } = localRequire("external-editor") as {
      ExternalEditor: new (text: string, options: object) => { tempFile: string; cleanup(): void };
    };
    const fixture = await mkdtemp(join(tmpdir(), "scr-editor-compat-"));
    try {
      const editor = new ExternalEditor("synthetic fixture", { tmpdir: fixture, prefix: "fixture-", postfix: ".txt" });
      try {
        expect(relative(fixture, editor.tempFile).startsWith("..")).toBe(false);
        expect(await readFile(editor.tempFile, "utf8")).toBe("synthetic fixture");
      } finally { editor.cleanup(); }
      expect(existsSync(editor.tempFile)).toBe(false);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
});
