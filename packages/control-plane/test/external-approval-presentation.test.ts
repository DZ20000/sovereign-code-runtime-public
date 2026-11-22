import { describe, expect, it } from "vitest";
import type { ExternalToolAuthorizationRequest } from "@sovereign/gateway/runtime";
import { externalApprovalPresentation } from "../src/external-approval-presentation.js";

const makeRequest = (input: Record<string, unknown>, name = "terminal.exec"): ExternalToolAuthorizationRequest => ({
  profile: "consequential",
  principal: { id: "principal-example", capabilities: new Set(), workspaceIds: new Set(["example-project"]) },
  spec: {
    name, version: "1.0.0", title: "Example operation", description: "Example operation",
    category: name === "files.delete" ? "files" : "terminal", requiredCapabilities: [],
    permissionLevel: "consequential", destructive: name === "files.delete", sideEffect: "process",
    approvalMode: "single-use", inputSchema: { type: "object", properties: {} },
  },
  input,
});

describe("external approval facts", () => {
  it("uses runtime principal and tool metadata without guessing administrator rights", () => {
    const result = externalApprovalPresentation(makeRequest({
      command: "Start-Process example -Verb RunAs",
      requesterId: "untrusted-display-name", administratorRequired: true,
    }));
    expect(result.context).toMatchObject({
      requesterId: "principal-example", workspaceId: "example-project",
      permissionLevel: "consequential", destructive: false,
      target: { kind: "command", value: "Start-Process example -Verb RunAs" },
    });
    expect(result.context?.administratorRequired).toBeUndefined();
    expect(result.title).not.toContain("ChatGPT");
    expect(result.title).not.toContain("Gemini");
  });

  it("keeps file targets and bounds arbitrary command text", () => {
    expect(externalApprovalPresentation(makeRequest({ path: "reports/summary.md" }, "files.delete")).context)
      .toMatchObject({ destructive: true, target: { kind: "path", value: "reports/summary.md" } });
    const long = externalApprovalPresentation(makeRequest({ command: "x".repeat(5_000) }));
    expect(long.context!.target.value).toHaveLength(2_000);
    expect(long.detail.length).toBeLessThan(2_300);
    expect(externalApprovalPresentation(makeRequest({ value: "not a known target" }, "custom.tool")).context!.target)
      .toEqual({ kind: "tool", value: "custom.tool" });
  });
});
