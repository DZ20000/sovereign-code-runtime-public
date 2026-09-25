import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  DesktopActiveToolActivity,
  DesktopAuditReceipt,
  DesktopRunSummary,
} from "../../apps/desktop/src/shared.js";
import {
  ACTIVITY_DISPLAY_LABELS,
  buildDesktopActivityFeed,
} from "../../apps/desktop/src/renderer/activity-feed.js";

function run(overrides: Partial<DesktopRunSummary> = {}): DesktopRunSummary {
  return {
    schemaVersion: "scr.run/v1",
    id: "11111111-1111-4111-8111-111111111111",
    kind: "terminal",
    label: "PowerShell command",
    workspaceId: "workspace",
    state: "succeeded",
    createdAt: "2026-08-20T01:00:00.000Z",
    startedAt: "2026-08-20T01:00:01.000Z",
    completedAt: "2026-08-20T01:00:02.000Z",
    exitCode: 0,
    signal: null,
    durationMs: 1_000,
    outputTruncated: false,
    cancelRequested: false,
    metadata: {},
    stdoutBytes: 10,
    stderrBytes: 0,
    ...overrides,
  };
}

function liveActivity(
  overrides: Partial<DesktopActiveToolActivity> = {},
): DesktopActiveToolActivity {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    toolName: "terminal.exec",
    title: "PowerShell command",
    category: "terminal",
    workspaceId: "workspace",
    startedAt: "2026-08-20T01:00:04.000Z",
    ...overrides,
  };
}

function receipt(overrides: Partial<DesktopAuditReceipt> = {}): DesktopAuditReceipt {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    occurredAt: "2026-08-20T01:00:03.000Z",
    principalId: "chatgpt-web",
    toolName: "files.replace_text",
    operation: "replace_text",
    outcome: "succeeded",
    workspaceId: "workspace",
    relativePath: "src/main.ts",
    beforeSha256: null,
    afterSha256: null,
    errorCode: null,
    ...overrides,
  };
}

describe("desktop activity feed", () => {
  it("merges managed runs and normal audit activity in newest-first order", () => {
    const feed = buildDesktopActivityFeed(
      [run()],
      [receipt()],
      { limit: 10 },
    );

    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      source: "audit",
      label: "File updated",
      detail: "src/main.ts",
      state: "succeeded",
    });
    expect(feed.items[1]).toMatchObject({
      source: "run",
      label: "PowerShell command",
      runId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not duplicate managed run start and completion receipts", () => {
    const feed = buildDesktopActivityFeed(
      [run()],
      [
        receipt({ id: "start", toolName: "terminal.start", operation: "start_powershell_run" }),
        receipt({ id: "complete", toolName: "runs.complete", operation: "complete_managed_run" }),
      ],
    );

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.source).toBe("run");
  });

  it("filters passive polling and capability probes", () => {
    const feed = buildDesktopActivityFeed([], [
      receipt({ id: "runs", toolName: "runs.list", operation: "list_runs" }),
      receipt({ id: "browser", toolName: "browser.capabilities", operation: "capabilities" }),
      receipt({ id: "manifest", toolName: "system.manifest", operation: "manifest" }),
      receipt({ id: "git", toolName: "git.commit", operation: "commit" }),
    ]);

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ category: "git", label: "Git checkpoint created" });
  });

  it("reports active runs and failures only from the visible recent slice", () => {
    const feed = buildDesktopActivityFeed(
      [run({ id: "active", state: "running", completedAt: null, durationMs: null })],
      [
        receipt({ id: "latest-failure", outcome: "failed", occurredAt: "2026-08-20T01:01:00.000Z" }),
        receipt({ id: "older-failure", outcome: "failed", occurredAt: "2026-08-20T00:59:00.000Z" }),
      ],
      { limit: 2 },
    );

    expect(feed.activeCount).toBe(1);
    expect(feed.items).toHaveLength(2);
    expect(feed.recentFailureCount).toBe(1);
  });

  it("uses safe labels and never exposes receipt principals or hashes", () => {
    const source = receipt({
      toolName: "computer.action",
      operation: "focus_window",
      principalId: "private-principal",
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
      relativePath: null,
    });
    const feed = buildDesktopActivityFeed([], [source]);
    const serialized = JSON.stringify(feed);

    expect(feed.items[0]).toMatchObject({
      label: "Desktop action completed",
      detail: "Computer · Focus window",
    });
    expect(serialized).not.toContain("private-principal");
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toContain("b".repeat(64));
  });

  it("keeps active runs ahead of newer completed calls", () => {
    const feed = buildDesktopActivityFeed(
      [run({
        id: "active-run",
        state: "running",
        completedAt: null,
        durationMs: null,
        startedAt: "2026-08-20T01:00:00.000Z",
      })],
      [receipt({
        id: "newer-audit",
        occurredAt: "2026-08-20T01:05:00.000Z",
      })],
    );

    expect(feed.items.map((item) => item.id)).toEqual([
      "run:active-run",
      "audit:newer-audit",
    ]);
  });

  it("filters passive workspace and terminal-read polling receipts", () => {
    const feed = buildDesktopActivityFeed([], [
      receipt({ id: "workspace", toolName: "workspace.list", operation: "list_workspaces" }),
      receipt({ id: "read", toolName: "terminal.session.read", operation: "read_terminal_session" }),
      receipt({ id: "write", toolName: "terminal.session.write", operation: "write_terminal_session" }),
    ]);

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      id: "audit:write",
      label: "Terminal input sent",
    });
  });

  it("keeps every explicit activity label in the localization source", () => {
    const localization = readFileSync(
      resolve(process.cwd(), "apps", "desktop", "src", "renderer", "localization-messages.ts"),
      "utf8",
    );
    const missing = Object.values(ACTIVITY_DISPLAY_LABELS).filter(
      (label) => !localization.includes(`["${label}",`),
    );
    expect(missing).toEqual([]);
  });

  it("shows live direct tool activity before its audit receipt exists", () => {
    const feed = buildDesktopActivityFeed([], [], {
      activeToolActivities: [liveActivity()],
    });

    expect(feed.activeCount).toBe(1);
    expect(feed.recentFailureCount).toBe(0);
    expect(feed.items).toEqual([
      expect.objectContaining({
        id: "live:33333333-3333-4333-8333-333333333333",
        source: "live",
        category: "terminal",
        label: "PowerShell command",
        detail: "Terminal · running",
        state: "running",
        active: true,
        failed: false,
        runId: null,
      }),
    ]);
  });

  it("filters passive and managed-run live lifecycle entries", () => {
    const feed = buildDesktopActivityFeed([], [], {
      activeToolActivities: [
        liveActivity({ id: "poll", toolName: "runs.list", title: "List runs", category: "runs" }),
        liveActivity({ id: "managed", toolName: "terminal.start", title: "Start run" }),
        liveActivity({ id: "direct", toolName: "files.replace_text", title: "Replace text", category: "files" }),
      ],
    });

    expect(feed.activeCount).toBe(1);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      id: "live:direct",
      label: "File updated",
      category: "files",
    });
  });

  it("keeps live activity ahead of completed records", () => {
    const feed = buildDesktopActivityFeed(
      [run()],
      [receipt()],
      { activeToolActivities: [liveActivity()] },
    );

    expect(feed.items.map((item) => item.source)).toEqual(["live", "audit", "run"]);
  });


  it("keeps task-control tools out of Recent activity", () => {
    const feed = buildDesktopActivityFeed(
      [],
      [
        receipt({ id: "task-list", toolName: "tasks.list", operation: "list_tasks" }),
        receipt({ id: "task-heartbeat", toolName: "tasks.heartbeat", operation: "task_heartbeat" }),
        receipt({ id: "file", toolName: "files.replace_text", operation: "replace_text" }),
      ],
      {
        activeToolActivities: [
          liveActivity({ id: "live-task", toolName: "tasks.update", title: "Update task", category: "tasks" }),
          liveActivity({ id: "live-file", toolName: "files.replace_text", title: "Replace text", category: "files" }),
        ],
      },
    );

    expect(feed.activeCount).toBe(1);
    expect(feed.items.map((item) => item.id)).toEqual([
      "live:live-file",
      "audit:file",
    ]);
    expect(JSON.stringify(feed)).not.toContain("tasks.");
  });

});
