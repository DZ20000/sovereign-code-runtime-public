import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createVisualWorkspace, removeVisualProfile, validateVisualWorkspace, type VisualWorkspace } from "../scripts/visual-workspace.mjs";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "sovereign-visual-workspace-test-"));
  roots.push(path);
  return path;
}
function environment(workspace: VisualWorkspace): NodeJS.ProcessEnv {
  return { SCR_VISUAL_OUTPUT: workspace.outputRoot, SCR_VISUAL_USER_DATA: workspace.userDataRoot, SCR_VISUAL_RUN_ID: workspace.runId };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("isolated visual workspace", () => {
  it("creates distinct output directories and removes only its own profile", async () => {
    const repositoryRoot = root();
    const first = createVisualWorkspace(repositoryRoot);
    const second = createVisualWorkspace(repositoryRoot);
    const evidence = join(first.outputRoot, "report.json");
    writeFileSync(evidence, "fixture evidence");
    expect(validateVisualWorkspace(repositoryRoot, environment(first))).toEqual(first);
    expect(first.outputRoot).not.toBe(second.outputRoot);
    await removeVisualProfile(first);
    expect(existsSync(first.userDataRoot)).toBe(false);
    expect(readFileSync(evidence, "utf8")).toBe("fixture evidence");
    expect(existsSync(second.userDataRoot)).toBe(true);
  });

  it("refuses repository, sibling, and mismatched-profile targets without removing them", async () => {
    const repositoryRoot = root();
    const first = createVisualWorkspace(repositoryRoot);
    const second = createVisualWorkspace(repositoryRoot);
    for (const output of [repositoryRoot, dirname(first.outputRoot), root()]) {
      expect(() => validateVisualWorkspace(repositoryRoot, { ...environment(first), SCR_VISUAL_OUTPUT: output })).toThrow();
      expect(existsSync(output)).toBe(true);
    }
    await expect(removeVisualProfile({ ...first, userDataRoot: second.userDataRoot })).rejects.toThrow();
    expect(existsSync(second.userDataRoot)).toBe(true);
  });

  it("refuses missing or forged ownership before Electron can use a profile", () => {
    const repositoryRoot = root();
    const workspace = createVisualWorkspace(repositoryRoot);
    expect(() => validateVisualWorkspace(repositoryRoot, {})).toThrow();
    expect(() => validateVisualWorkspace(repositoryRoot, { ...environment(workspace), SCR_VISUAL_RUN_ID: "00000000-0000-0000-0000-000000000000" })).toThrow();
    writeFileSync(join(workspace.outputRoot, "visual-run-owner.json"), "{}");
    expect(() => validateVisualWorkspace(repositoryRoot, environment(workspace))).toThrow();
    expect(existsSync(workspace.userDataRoot)).toBe(true);
  });

  it("refuses a scratch-directory junction before creating output outside the repository", () => {
    const repositoryRoot = root();
    const outside = root();
    mkdirSync(join(repositoryRoot, ".sovereign"));
    symlinkSync(outside, join(repositoryRoot, ".sovereign", "scratch"), process.platform === "win32" ? "junction" : "dir");
    expect(() => createVisualWorkspace(repositoryRoot)).toThrow();
    expect(existsSync(outside)).toBe(true);
  });
});
