import { invoke } from "@tauri-apps/api/core";
import type { DesktopApprovalView, SovereignApprovalApi } from "@sovereign/control-plane-contract";
import "../../desktop/src/renderer/approval.css";

const approvalSmokeAutoAllow =
  new URL(window.location.href).searchParams.get("approvalSmoke") === "allow-once";

const api: SovereignApprovalApi = {
  async getCurrent() {
    const approval = await invoke<DesktopApprovalView | null>("approval_current");
    if (
      approvalSmokeAutoAllow &&
      approval?.id.startsWith("approval-smoke-") &&
      approval.toolName === "terminal.start" &&
      approval.title === "L3 Consequential · Approval smoke"
    ) {
      window.setTimeout(() => document.querySelector<HTMLButtonElement>("#approval-allow")?.click(), 0);
    }
    return approval;
  },
  resolve: (requestId, decision) => invoke<void>("approval_resolve", { requestId, decision }),
};

Object.defineProperty(window, "sovereignApproval", {
  value: api,
  configurable: false,
  enumerable: false,
  writable: false,
});

await import("../../desktop/src/renderer/approval.js");
