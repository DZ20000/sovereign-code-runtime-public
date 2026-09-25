import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGitSource } from "../scripts/release-metadata.mjs";

function git(root:string, ...args:string[]):string {
  return execFileSync("git", args, {cwd:root,encoding:"utf8",windowsHide:true,
    env:{...process.env,GIT_AUTHOR_NAME:"Source test",GIT_COMMITTER_NAME:"Source test",
      GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_EMAIL:"fixture@example.invalid"},
  }).trim();
}
describe("source provenance boundary", () => {
  it("rejects a source archive rather than borrowing the enclosing repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-source-archive-"));
    try {
      await expect(readGitSource(root)).rejects.toThrow(/Git clone/);
      git(root,"init","--quiet");
      git(root,"-c","commit.gpgsign=false","-c","core.hooksPath=NUL","commit","--allow-empty","-m","fixture");
      const archive = join(root,"archive"); await mkdir(archive);
      await expect(readGitSource(archive)).rejects.toThrow(/Source archives without .git/);
      await writeFile(join(archive,".git"),"gitdir: ../.git\n");
      await expect(readGitSource(archive)).rejects.toThrow(/Git clone/);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it("binds a real checkout to its exact commit and preserves dirty/detached state", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-source-checkout-"));
    try {
      git(root,"init","--quiet");
      await expect(readGitSource(root)).rejects.toThrow(/checked-out commit/);
      git(root,"-c","commit.gpgsign=false","-c","core.hooksPath=NUL","commit","--allow-empty","-m","fixture");
      const commit = git(root,"rev-parse","HEAD");
      expect(await readGitSource(root)).toMatchObject({commit,dirty:false,changeCount:0});
      git(root,"checkout","--quiet","--detach",commit);
      expect(await readGitSource(root)).toMatchObject({commit,branch:null,dirty:false});
      await writeFile(join(root,"changed.txt"),"fixture\n");
      expect(await readGitSource(root)).toMatchObject({commit,dirty:true,changeCount:1});
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
