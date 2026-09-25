import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import {
  NativeNotificationManager,
  WindowsAdapter,
  normalizeDesktopNotification,
  type NativeNotificationRunner,
} from "../src/index.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

describe("Windows notification manager", () => {
  it("normalizes bounded visible text and validates duration", () => {
    expect(
      normalizeDesktopNotification({
        title: "  Task\n complete  ",
        message: "Build\tpassed\u0000 successfully.",
        severity: "success",
        durationMs: 7_000,
      }),
    ).toEqual({
      title: "Task complete",
      message: "Build passed successfully.",
      severity: "success",
      durationMs: 7_000,
    });

    expect(() =>
      normalizeDesktopNotification({
        title: "ok",
        message: "message",
        durationMs: 2_999,
      }),
    ).toThrow(/duration/u);
    expect(() =>
      normalizeDesktopNotification({
        title: " ",
        message: "message",
      }),
    ).toThrow(/title/u);
  });

  it("uses the native helper protocol and reports acceptance rather than visibility", async () => {
    const calls: Array<{
      readonly executable: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
    }> = [];
    const runner: NativeNotificationRunner = async (
      executable,
      args,
      timeoutMs,
    ) => {
      calls.push({ executable, args, timeoutMs });
      return ["NOTIFIED"];
    };
    const manager = new NativeNotificationManager(
      "C:\\fake\\SovereignNativeAgent.exe",
      {
        runner,
        now: () => Date.parse("2026-08-18T12:00:00.000Z"),
        pathExists: () => true,
        platform: "win32",
      },
    );

    const result = await manager.notify({
      title: "Checkpoint complete",
      message: "Typecheck, tests, and build passed.",
      severity: "success",
      durationMs: 5_000,
    });

    expect(result).toMatchObject({
      accepted: true,
      acceptedAt: "2026-08-18T12:00:00.000Z",
      mechanism: "windows-notify-icon",
      severity: "success",
      durationMs: 5_000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: "C:\\fake\\SovereignNativeAgent.exe",
      timeoutMs: 10_000,
    });
    expect(calls[0]?.args[0]).toBe("notify");
    expect(decode(calls[0]?.args[1] ?? "")).toBe("Checkpoint complete");
    expect(decode(calls[0]?.args[2] ?? "")).toBe(
      "Typecheck, tests, and build passed.",
    );
    expect(calls[0]?.args.slice(3)).toEqual(["success", "5000"]);
  });

  it("accepts repeated identical semantic notifications without content hashing", async () => {
    const calls: string[] = [];
    const manager = new NativeNotificationManager(
      "C:\\fake\\SovereignNativeAgent.exe",
      {
        runner: async (_executable, args) => {
          calls.push(`${decode(args[1] ?? "")}:${decode(args[2] ?? "")}`);
          return ["NOTIFIED"];
        },
        now: () => 10_000,
        pathExists: () => true,
        platform: "win32",
      },
    );

    await expect(
      manager.notify({ title: "Work complete", message: "Ready for review." }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      manager.notify({ title: "Work complete", message: "Ready for review." }),
    ).resolves.toMatchObject({ accepted: true });

    expect(calls).toEqual([
      "Work complete:Ready for review.",
      "Work complete:Ready for review.",
    ]);
  });

  it("allows concurrent notifications to complete independently", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const manager = new NativeNotificationManager(
      "C:\\fake\\SovereignNativeAgent.exe",
      {
        runner: async (_executable, args) =>
          await new Promise<readonly string[]>((resolve) => {
            calls.push(decode(args[1] ?? ""));
            releases.push(() => resolve(["NOTIFIED"]));
          }),
        now: () => 10_000,
        pathExists: () => true,
        platform: "win32",
      },
    );

    const first = manager.notify({ title: "One", message: "First" });
    const second = manager.notify({ title: "One", message: "First" });
    const third = manager.notify({ title: "Three", message: "Third" });
    expect(calls).toEqual(["One", "One", "Three"]);

    for (const release of releases.splice(0).reverse()) release();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
  });

  it("does not retain failed helper state across a later notification", async () => {
    let attempt = 0;
    const manager = new NativeNotificationManager(
      "C:\\fake\\SovereignNativeAgent.exe",
      {
        runner: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("helper failed");
          return ["NOTIFIED"];
        },
        now: () => 10_000,
        pathExists: () => true,
        platform: "win32",
      },
    );

    await expect(
      manager.notify({ title: "One", message: "First" }),
    ).rejects.toThrow("helper failed");
    await expect(
      manager.notify({ title: "Two", message: "Second" }),
    ).resolves.toMatchObject({
      accepted: true,
    });
  });

  it("writes hashes and lengths to the audit ledger without raw notification text", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-notify-"));
    cleanupPaths.push(root);
    const audit = new MemoryAuditStore();
    const manager = new NativeNotificationManager(
      "C:\\fake\\SovereignNativeAgent.exe",
      {
        runner: async () => ["NOTIFIED"],
        pathExists: () => true,
        platform: "win32",
        now: () => Date.parse("2026-08-18T12:30:00.000Z"),
      },
    );
    const adapter = new WindowsAdapter({
      workspaces: [{ id: "workspace", root }],
      policy: new PolicyEngine(),
      audit,
      notificationManager: manager,
    });
    const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);
    const privateTitle = "Finished private task";
    const privateMessage = "Private file names must not enter the receipt.";

    const result = await adapter.notifyDesktop(owner, {
      title: privateTitle,
      message: privateMessage,
      severity: "success",
    });

    expect(result.receiptId).toMatch(/^[a-f0-9-]{36}$/u);
    const receipt = audit.list(1)[0];
    expect(receipt).toMatchObject({
      id: result.receiptId,
      toolName: "system.notify",
      operation: "show_windows_notification",
      outcome: "succeeded",
      details: {
        titleCharacters: privateTitle.length,
        messageCharacters: privateMessage.length,
        severity: "success",
      },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(privateTitle);
    expect(serialized).not.toContain(privateMessage);
    expect(serialized).toMatch(/titleSha256/u);
    expect(serialized).toMatch(/messageSha256/u);
    await adapter.shutdown();
  });

  it("requires the dedicated notification capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-notify-policy-"));
    cleanupPaths.push(root);
    const audit = new MemoryAuditStore();
    const adapter = new WindowsAdapter({
      workspaces: [{ id: "workspace", root }],
      policy: new PolicyEngine(),
      audit,
      notificationManager: new NativeNotificationManager(
        "C:\\fake\\SovereignNativeAgent.exe",
        {
          runner: async () => ["NOTIFIED"],
          pathExists: () => true,
          platform: "win32",
        },
      ),
    });
    const observer = createPrincipal(
      "observer",
      CAPABILITIES.filter((capability) => capability !== "system.notify"),
      ["workspace"],
    );

    await expect(
      adapter.notifyDesktop(observer, {
        title: "Denied",
        message: "This should not reach the helper.",
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(audit.list(1)[0]).toMatchObject({
      toolName: "system.notify",
      outcome: "denied",
      errorCode: "POLICY_DENIED",
    });
    await adapter.shutdown();
  });
});
