import { describe, expect, it } from "vitest";

import {
  PolicyEngine,
  RuntimeError,
  createPrincipal,
} from "@sovereign/runtime-core";
import { ToolCatalog, defineTool, objectSchema } from "../src/index.js";
import {
  requireSuccessfulTerminalExecution,
  toolExecutionReceiptId,
} from "../src/terminal-execution-result.js";

describe("terminal execution result integrity", () => {
  it("requires exit code zero and a bounded execution receipt", () => {
    const result = { exitCode: 0, receiptId: "receipt-success" };
    expect(requireSuccessfulTerminalExecution(result)).toBe(result);
    expect(toolExecutionReceiptId(result)).toBe("receipt-success");
    expect(() =>
      requireSuccessfulTerminalExecution({ exitCode: 0 }),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });

  it("does not run terminal.exec when execution evidence cannot be persisted", async () => {
    let executed = false;
    const definition = defineTool(
      {
        name: "terminal.exec",
        version: "1.0.0",
        title: "Terminal test",
        description: "Terminal execution evidence test.",
        category: "terminal",
        requiredCapabilities: [],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      () => {
        executed = true;
        return { exitCode: 0, receiptId: "should-not-exist" };
      },
    );
    const catalog = new ToolCatalog(
      [definition],
      new PolicyEngine(),
      "test",
      undefined,
      undefined,
      () => {
        throw new Error("task evidence unavailable");
      },
    );

    await expect(
      catalog.invoke(
        "terminal.exec",
        { principal: createPrincipal("owner", [], []), sessionId: "session-a" },
        {},
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Could not persist terminal execution evidence.",
    });
    expect(executed).toBe(false);
  });

  it("reports PATH_REJECTED without inventing a success receipt", async () => {
    const events: Array<{
      readonly phase: string;
      readonly outcome: string | null;
      readonly errorCode: string | null;
      readonly receiptId: string | null;
    }> = [];
    const definition = defineTool(
      {
        name: "terminal.exec",
        version: "1.0.0",
        title: "Terminal test",
        description: "Terminal path rejection test.",
        category: "terminal",
        requiredCapabilities: [],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      () => {
        throw new RuntimeError("PATH_REJECTED", "cwd not found", 404, {
          requestedPath: ".",
        });
      },
    );
    const catalog = new ToolCatalog(
      [definition],
      new PolicyEngine(),
      "test",
      undefined,
      undefined,
      (event) => {
        events.push(event);
      },
    );

    await expect(
      catalog.invoke(
        "terminal.exec",
        { principal: createPrincipal("owner", [], []), sessionId: "session-a" },
        {},
      ),
    ).rejects.toMatchObject({
      code: "PATH_REJECTED",
      details: { requestedPath: "." },
    });
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      outcome: "failed",
      errorCode: "PATH_REJECTED",
      receiptId: null,
    });
  });
  it("reports a non-zero terminal result as failed activity with its receipt", async () => {
    const events: Array<{
      readonly phase: string;
      readonly outcome: string | null;
      readonly errorCode: string | null;
      readonly receiptId: string | null;
    }> = [];
    const definition = defineTool(
      {
        name: "terminal.exec",
        version: "1.0.0",
        title: "Terminal test",
        description: "Terminal execution result test.",
        category: "terminal",
        requiredCapabilities: [],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      () =>
        requireSuccessfulTerminalExecution({
          exitCode: 7,
          receiptId: "receipt-failed",
        }),
    );
    const catalog = new ToolCatalog(
      [definition],
      new PolicyEngine(),
      "test",
      undefined,
      undefined,
      (event) => {
        events.push(event);
      },
    );

    await expect(
      catalog.invoke(
        "terminal.exec",
        { principal: createPrincipal("owner", [], []), sessionId: "session-a" },
        {},
      ),
    ).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      details: { receiptId: "receipt-failed", exitCode: 7 },
    });
    expect(events).toEqual([
      expect.objectContaining({
        phase: "started",
        outcome: null,
        errorCode: null,
        receiptId: null,
      }),
      expect.objectContaining({
        phase: "completed",
        outcome: "failed",
        errorCode: "PROCESS_FAILED",
        receiptId: "receipt-failed",
      }),
    ]);
  });
});
