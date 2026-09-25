import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectGitEvidence,
  createSessionHandoff,
  parseCliArguments,
  runSessionHandoffCli,
  validateHandoffInput,
  verifySessionContinuationAnchor,
} from "../../scripts/session-handoff.mjs";
import type { SessionHandoffInput } from "../../scripts/session-handoff.mjs";

const cleanupPaths: string[] = [];

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scr-session-handoff-"));
  cleanupPaths.push(root);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", root], {
    windowsHide: true,
  });
  runGit(root, ["config", "user.email", "handoff@example.test"]);
  runGit(root, ["config", "user.name", "Handoff Test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "tracked.ts"), "export const value = 1;\n");
  await writeFile(join(root, "README.md"), "# Fixture\n");
  runGit(root, ["add", "README.md", "src/tracked.ts"]);
  runGit(root, ["commit", "--quiet", "-m", "fixture baseline"]);
  await writeFile(
    join(root, "src", "tracked.ts"),
    "export const value = 2; // SOURCE_CONTENT_MUST_NOT_ENTER_HANDOFF\n",
  );
  await writeFile(
    join(root, "notes.txt"),
    "UNTRACKED_CONTENT_MUST_NOT_ENTER_HANDOFF\n",
  );
  return root;
}

function input(
  overrides: Partial<SessionHandoffInput> = {},
): SessionHandoffInput {
  return {
    schemaVersion: "scr.session-handoff-input/v1",
    reason: "context-limit",
    task: {
      id: "task-123",
      title: "Complete the bounded handoff workflow",
      goal: "Let a replacement main session resume verified local development without a transcript.",
      currentStep:
        "Validate the generated report against the current Git worktree.",
      completed: [
        "Defined the bounded input schema.",
        "Added Git-only evidence collection.",
      ],
      remaining: [
        "Run focused and broad validation.",
        "Commit only the reviewed handoff files.",
      ],
      decisions: [
        "The main session is the default owner; support sessions are explicit.",
      ],
      limitations: [
        "The local runtime cannot read an opaque ChatGPT context-window counter.",
      ],
      openQuestions: [
        "Whether a future observer can provide a trusted pressure signal.",
      ],
      validation: [
        {
          name: "pnpm typecheck",
          status: "passed",
          summary: "No TypeScript error.",
        },
        {
          name: "full installer cutover",
          status: "not-run",
          summary: "Restart is out of scope.",
        },
      ],
    },
    ...overrides,
  };
}

function taskWith(
  overrides: Partial<SessionHandoffInput["task"]>,
): SessionHandoffInput {
  const base = input();
  return { ...base, task: { ...base.task, ...overrides } };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("session handoff", () => {
  it("writes a bounded main-session Markdown handoff with Git evidence but no source contents", async () => {
    const root = await fixture();
    const result = await createSessionHandoff({ root, input: input() });
    const markdown = await readFile(result.outputPath, "utf8");

    expect(result.schemaVersion).toBe("scr.session-handoff/v1");
    const { continuation: _continuation, ...legacyNormalizedInput } =
      validateHandoffInput(input());
    expect(result.inputDigest).toBe(
      createHash("sha256")
        .update(JSON.stringify(legacyNormalizedInput), "utf8")
        .digest("hex"),
    );
    expect(result.continuationAnchor).toBeNull();
    expect(markdown).not.toContain("SCR_SESSION_CONTINUATION_ANCHOR");
    expect(markdown).not.toContain("## Continuation correlation");
    expect(result.relativeOutputPath).toMatch(
      /^\.sovereign\/handoffs\/handoff-\d{8}-\d{9}Z-[a-f0-9]{12}-complete-the-bounded-handoff-workflow\.md$/u,
    );
    expect(markdown).toContain("Session role: `main`");
    expect(markdown).toContain("Reason: `context-limit`");
    expect(markdown).toContain("Task ID: `task-123`");
    expect(markdown).toContain("## Resume protocol");
    expect(markdown).toContain("` M src/tracked.ts`");
    expect(markdown).toContain("`?? notes.txt`");
    expect(markdown).toContain(runGit(root, ["rev-parse", "HEAD"]));
    expect(markdown).toContain("fixture baseline");
    expect(markdown).not.toContain("SOURCE_CONTENT_MUST_NOT_ENTER_HANDOFF");
    expect(markdown).not.toContain("UNTRACKED_CONTENT_MUST_NOT_ENTER_HANDOFF");
    expect(markdown).not.toContain("git diff");
    expect(result.git.dirty).toBe(true);
    expect(result.git.status).toEqual(
      expect.arrayContaining([" M src/tracked.ts", "?? notes.txt"]),
    );
  });

  it("supports an explicitly selected support session while keeping main as the default", () => {
    expect(validateHandoffInput(input()).sessionRole).toBe("main");
    expect(
      validateHandoffInput(input({ sessionRole: "support" })).sessionRole,
    ).toBe("support");
  });

  it("chains task-bound continuation anchors without granting browser or capability authority", async () => {
    const root = await fixture();
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const first = await createSessionHandoff({
      root,
      input: input({
        reason: "compaction",
        continuation: { epoch: 1 },
      }),
      output: ".sovereign/handoffs/continuation-1.md",
    });
    const firstAnchor = first.continuationAnchor;
    if (firstAnchor === null) throw new Error("Expected the first anchor.");
    const firstMarkdown = await readFile(first.outputPath, "utf8");
    expect(
      verifySessionContinuationAnchor(firstMarkdown, {
        taskId: "task-123",
        epoch: 1,
        previousAnchorId: null,
        branch: "main",
        head,
      }),
    ).toEqual(firstAnchor);
    expect(firstMarkdown).toContain(
      "not a capability token, browser lease, conversation transcript, or authority grant",
    );
    expect(firstMarkdown).not.toContain("Codex");
    expect(firstMarkdown).not.toMatch(/conversation_url|surfaceNonce/iu);

    const second = await createSessionHandoff({
      root,
      input: input({
        reason: "compaction",
        continuation: {
          epoch: 2,
          previousAnchorId: firstAnchor.anchorId,
        },
      }),
      output: ".sovereign/handoffs/continuation-2.md",
    });
    const secondAnchor = second.continuationAnchor;
    if (secondAnchor === null) throw new Error("Expected the second anchor.");
    const secondMarkdown = await readFile(second.outputPath, "utf8");
    expect(
      verifySessionContinuationAnchor(secondMarkdown, {
        taskId: "task-123",
        epoch: 2,
        previousAnchorId: firstAnchor.anchorId,
        branch: "main",
        head,
      }),
    ).toEqual(secondAnchor);
    expect(secondAnchor.anchorId).not.toBe(firstAnchor.anchorId);

    expect(() =>
      verifySessionContinuationAnchor(
        firstMarkdown.replace("## Goal", "## Altered goal"),
      ),
    ).toThrow("body digest does not match");
    expect(() =>
      verifySessionContinuationAnchor(firstMarkdown, {
        head: "0".repeat(40),
      }),
    ).toThrow("head does not match");
  });

  it("rejects ambiguous or unbound continuation epochs", () => {
    expect(() =>
      validateHandoffInput(
        input({
          continuation: {
            epoch: 1,
            previousAnchorId: "a".repeat(64),
          },
        }),
      ),
    ).toThrow("first session continuation epoch");
    expect(() =>
      validateHandoffInput(input({ continuation: { epoch: 2 } })),
    ).toThrow("requires the previous anchor ID");
    const withoutTaskId = input();
    const taskWithoutId = {
      ...withoutTaskId.task,
    } as Record<string, unknown>;
    delete taskWithoutId.id;
    expect(() =>
      validateHandoffInput({
        ...withoutTaskId,
        task: taskWithoutId,
        continuation: { epoch: 1 },
      }),
    ).toThrow("requires a Task ID");
  });

  it("rejects credentials, private reasoning, transcripts, and unsupported validation states", () => {
    expect(() =>
      validateHandoffInput(
        taskWith({ goal: "Use Bearer abcdefghijklmnopqrstuvwxyz123456" }),
      ),
    ).toThrow("credential material");
    expect(() =>
      validateHandoffInput(
        taskWith({ currentStep: "Copy the hidden reasoning scratchpad." }),
      ),
    ).toThrow("private reasoning or scratchpad");
    expect(() =>
      validateHandoffInput({
        ...input(),
        transcript: "full conversation",
      } as unknown),
    ).toThrow("unknown field: transcript");
    expect(() =>
      validateHandoffInput(
        taskWith({
          validation: [{ name: "test", status: "successful" as "passed" }],
        }),
      ),
    ).toThrow("status is unsupported");
  });

  it("refuses volume roots, nested non-root repositories, unsafe output paths, and overwrites", async () => {
    const root = await fixture();
    await expect(collectGitEvidence(parse(root).root)).rejects.toThrow(
      "filesystem or volume root",
    );
    await expect(collectGitEvidence(join(root, "src"))).rejects.toThrow(
      "exact Git worktree root",
    );
    await expect(
      createSessionHandoff({ root, input: input(), output: "../outside.md" }),
    ).rejects.toThrow("inside .sovereign/handoffs");

    const output = ".sovereign/handoffs/fixed.md";
    await createSessionHandoff({ root, input: input(), output });
    await expect(
      createSessionHandoff({ root, input: input(), output }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("rejects a file reached through a directory link that escapes the canonical root", async () => {
    const root = await fixture();
    const outside = await mkdtemp(
      join(tmpdir(), "scr-session-handoff-outside-"),
    );
    cleanupPaths.push(outside);
    await writeFile(join(outside, "handoff.json"), JSON.stringify(input()));
    await symlink(
      outside,
      join(root, "linked-input"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      runSessionHandoffCli([
        "--root",
        root,
        "--input",
        "linked-input/handoff.json",
      ]),
    ).rejects.toThrow("canonical workspace root");
  });

  it("redacts every credential and private-reasoning occurrence in Git-derived evidence", async () => {
    const root = await fixture();
    await writeFile(join(root, "README.md"), "# Updated fixture\n");
    runGit(root, ["add", "README.md"]);
    runGit(root, [
      "commit",
      "--quiet",
      "-m",
      "Bearer abcdefghijklmnopqrstuvwxyz123456 then private scratchpad then Bearer zyxwvutsrqponmlkjihgfedcba654321",
    ]);

    const result = await createSessionHandoff({ root, input: input() });
    const markdown = await readFile(result.outputPath, "utf8");
    expect(markdown).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(markdown).not.toContain("zyxwvutsrqponmlkjihgfedcba654321");
    expect(markdown).not.toContain("private scratchpad");
    expect(markdown.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("requires exactly one bounded CLI input source", () => {
    expect(parseCliArguments(["--root", ".", "--stdin"])).toEqual({
      root: ".",
      input: null,
      stdin: true,
      output: "auto",
    });
    expect(() => parseCliArguments(["--root", "."])).toThrow("exactly one");
    expect(() =>
      parseCliArguments(["--root", ".", "--stdin", "--input", "handoff.json"]),
    ).toThrow("exactly one");
    expect(() =>
      parseCliArguments(["--root", ".", "--stdin", "--delete"]),
    ).toThrow("Unknown session handoff argument");
  });

  it("keeps the project skill focused on evidence revalidation rather than transcript recovery", async () => {
    const skill = await readFile(
      join(process.cwd(), "docs", "session-handoff.md"),
      "utf8",
    );
    expect(skill).toContain("name: session-handoff");
    expect(skill).toContain("Tasks inbox");
    expect(skill).toContain("main session");
    expect(skill).toContain("evidence, not authority");
    expect(skill).not.toContain("Codex is the local owner");
    expect(skill).not.toContain("conversation transcript");
  });
});
