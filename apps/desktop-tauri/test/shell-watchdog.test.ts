import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- the watchdog ships as plain ESM beside the shell.
import { processMatches, run, shellIsRunning } from "../shell-watchdog.mjs";

const IMAGE = "sovereign-desktop-tauri.exe";
const roots: string[] = [];

/** No shell running, no live process ids, and a launch that only records the call. */
function probes(overrides: Record<string, unknown> = {}) {
  return {
    byProcessId: (pid: number) => ({ status: 0, stdout: pid === 31337 ? `"${IMAGE}","31337"` : "" }),
    byImageName: () => ({ status: 0, stdout: "INFO: No tasks are running." }),
    launch: () => 31337,
    ...overrides,
  };
}

async function guardianRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scr-watchdog-"));
  roots.push(root);
  return root;
}

async function writeControl(root: string, name: string, parentPid: number): Promise<void> {
  await writeFile(
    join(root, name),
    JSON.stringify({
      schemaVersion: "scr.host-guardian-control/v1",
      token: "t".repeat(43),
      intent: "running",
      parentPid,
      updatedAtUnixMs: String(Date.now()),
    }),
    "utf8",
  );
}

async function readReport(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell watchdog process matching", () => {
  it("accepts a live process whose image is the shell", () => {
    const matched = processMatches(4242, IMAGE, () => ({
      status: 0,
      stdout: `"${IMAGE}","4242","Console","1","120,000 K"\r\n`,
    }));
    expect(matched).toBe(true);
  });

  it("rejects a recycled id now held by another program", () => {
    const matched = processMatches(4242, IMAGE, () => ({
      status: 0,
      stdout: '"notepad.exe","4242","Console","1","9,000 K"\r\n',
    }));
    expect(matched).toBe(false);
  });

  it.each([0, -1, Number.NaN, 1.5])("rejects the invalid process id %s", (value) => {
    expect(processMatches(value, IMAGE, () => ({ status: 0, stdout: "" }))).toBe(false);
  });

  it("treats a failed query as absent rather than present", () => {
    expect(processMatches(4242, IMAGE, () => ({ status: 1, stdout: "" }))).toBe(false);
    expect(shellIsRunning(IMAGE, () => ({ status: 1, stdout: "" }))).toBe(false);
  });
});

describe("shell watchdog decisions", () => {
  it.each([null, "throw", 99])("preserves recovery evidence after launch failure %s and retries next run", async (failure) => {
    const root = await guardianRoot();
    const report = join(root, "report.json");
    const control = join(root, "control-4242-abc.json");
    await writeControl(root, "control-4242-abc.json", 4242);
    const args = ["--shell", join(root, IMAGE), "--guardian-state", root, "--report", report];
    await run(args, probes({ launch: async () => {
      if (failure === "throw") throw new Error("spawn failed");
      return failure;
    } }));
    expect(await readReport(report)).toMatchObject({ outcome: "restart-failed", clearedControls: 0 });
    await expect(readFile(control, "utf8")).resolves.toContain("4242");
    await run(args, probes());
    expect(await readReport(report)).toMatchObject({ outcome: "restarted", restartedProcessId: 31337 });
    await expect(readFile(control, "utf8")).rejects.toThrow();
  });
  it("stays quiet when no control file outlived its shell", async () => {
    const root = await guardianRoot();
    const report = join(root, "report.json");
    await run(
      ["--shell", join(root, IMAGE), "--guardian-state", root, "--report", report],
      probes(),
    );
    expect((await readReport(report)).outcome).toBe("no-evidence-of-an-unclean-exit");
  });

  it("ignores a file that is not a guardian control record", async () => {
    const root = await guardianRoot();
    const report = join(root, "report.json");
    await writeFile(join(root, "control-99999-abc.json"), "{ not json", "utf8");
    await writeFile(join(root, "restart-history.json"), JSON.stringify({ a: 1 }), "utf8");
    await run(
      ["--shell", join(root, IMAGE), "--guardian-state", root, "--report", report],
      probes(),
    );
    expect((await readReport(report)).outcome).toBe("no-evidence-of-an-unclean-exit");
  });

  it("leaves a control file alone while its shell is still alive", async () => {
    const root = await guardianRoot();
    const report = join(root, "report.json");
    await writeControl(root, "control-4242-abc.json", 4242);
    await run(
      ["--shell", join(root, IMAGE), "--guardian-state", root, "--report", report],
      probes({
        byProcessId: () => ({ status: 0, stdout: `"${IMAGE}","4242","Console","1","120,000 K"` }),
      }),
    );
    expect((await readReport(report)).outcome).toBe("no-evidence-of-an-unclean-exit");
    await expect(readFile(join(root, "control-4242-abc.json"), "utf8")).resolves.toContain("4242");
  });

  it("restarts and clears the record when a control file outlived its shell", async () => {
    const root = await guardianRoot();
    const report = join(root, "report.json");
    // A process id that cannot be live: the shell image never runs under it.
    await writeControl(root, "control-4294967294-abc.json", 4_294_967_294);
    await run(
      ["--shell", join(root, IMAGE), "--guardian-state", root, "--report", report],
      probes(),
    );
    const result = await readReport(report);
    expect(result.outcome).toBe("restarted");
    expect(result.clearedControls).toBe(1);
    await expect(readFile(join(root, "control-4294967294-abc.json"), "utf8")).rejects.toThrow();
  });

  it.each([["--shell"], ["--guardian-state"], ["--report"]])(
    "refuses to run without %s",
    async (missing) => {
      const root = await guardianRoot();
      const argv = [
        "--shell",
        join(root, IMAGE),
        "--guardian-state",
        root,
        "--report",
        join(root, "report.json"),
      ];
      const index = argv.indexOf(missing);
      argv.splice(index, 2);
      await expect(run(argv, probes())).rejects.toThrow(/Missing shell watchdog argument/u);
    },
  );

  it("refuses a duplicated argument", async () => {
    const root = await guardianRoot();
    await expect(
      run([
        "--shell",
        join(root, IMAGE),
        "--shell",
        join(root, IMAGE),
        "--guardian-state",
        root,
        "--report",
        join(root, "report.json"),
      ], probes()),
    ).rejects.toThrow(/Duplicate shell watchdog argument/u);
  });
});
