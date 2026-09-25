import { describe, expect, it } from "vitest";
import { formatTerminalOutput } from "../src/renderer/terminal-output.js";

const session = { state: "running" as const, output: "最后一行", outputTruncated: false, error: null };

describe("terminal output presentation", () => {
  it("preserves complete output without adding a truncation notice", () => {
    expect(formatTerminalOutput(session, "zh-CN")).toBe("最后一行");
  });
  it("labels the retained tail in Chinese", () => {
    expect(formatTerminalOutput({ ...session, outputTruncated: true }, "zh-CN")).toBe("[部分较早的输出已省略，以下为最近保留的输出]\n最后一行");
  });
  it("labels the retained tail in English and keeps explicit errors", () => {
    expect(formatTerminalOutput({ ...session, outputTruncated: true, error: "stopped" }, "en-US")).toBe("[Earlier output omitted; showing the latest retained output]\n最后一行\n[error] stopped");
  });
  it("distinguishes startup from a terminal with no captured output", () => {
    expect(formatTerminalOutput({ ...session, state: "starting", output: "" }, "zh")).toContain("正在启动");
    expect(formatTerminalOutput({ ...session, output: "" }, "en")).toBe("No terminal output captured.");
  });
});
