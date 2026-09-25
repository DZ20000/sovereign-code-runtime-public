import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

async function text(path: string): Promise<string> {
  return await readFile(resolve(root, path), "utf8");
}

describe("Runtime candidate signed cutover boundary", () => {
  it("accepts only releaseId and enables mutations only in the trusted Tauri shell", async () => {
    const [api, electronPreload, tauriBridge] = await Promise.all([
      text("packages/control-plane-contract/src/api.ts"),
      text("apps/desktop/src/preload.ts"),
      text("apps/desktop-tauri/src/bridge.ts"),
    ]);

    expect(api).toMatch(
      /installRuntimeCandidateUpdate\(\s*releaseId: string,?\s*\)/u,
    );
    expect(api).toMatch(
      /activateRuntimeCandidateUpdate\(\s*releaseId: string,?\s*\)/u,
    );
    expect(tauriBridge).toContain(
      'invoke<RuntimeCandidateUpdateStatus>("runtime_candidate_update_status")',
    );
    expect(tauriBridge).toContain('"install_runtime_candidate_update"');
    expect(tauriBridge).toContain('"activate_runtime_candidate_update"');
    expect(tauriBridge).toContain("rejectDuringRendererPreflight");
    expect(tauriBridge).not.toContain("disabledRuntimeCandidateUpdateStatus");

    expect(electronPreload).toContain("disabledRuntimeCandidateUpdateStatus");
    expect(electronPreload).toContain(
      "installRuntimeCandidateUpdate: () => rejectRuntimeCandidateUpdateInElectron()",
    );
    expect(electronPreload).toContain(
      "activateRuntimeCandidateUpdate: () => rejectRuntimeCandidateUpdateInElectron()",
    );
  });

  it("keeps trust, path, digest, checkpoint and fence material out of public data", async () => {
    const contract = await text(
      "packages/control-plane-contract/src/runtime-candidate-update.ts",
    );
    for (const name of [
      "slotRoot",
      "runtimeHostSha256",
      "manifestSha256",
      "signature",
      "publicKey",
      "keyId",
      "checkpointId",
      "instanceId",
      "generation",
      "fencingToken",
      "authorization",
    ]) {
      expect(contract).not.toContain(name);
    }
    expect(contract).toContain("activeReleaseId");
    expect(contract).toContain("installedReleaseIds");
    expect(contract).toContain('outcome: "activated"');
  });

  it("stays disabled when no trusted Runtime signing key is provisioned", async () => {
    const [registryText, configText, manager] = await Promise.all([
      text("apps/desktop-tauri/src-tauri/runtime-candidate-trusted-keys.json"),
      text("apps/desktop-tauri/src-tauri/tauri.conf.json"),
      text("apps/desktop-tauri/src-tauri/src/runtime_candidate_update.rs"),
    ]);
    const registry = JSON.parse(registryText) as {
      readonly schemaVersion: string;
      readonly keys: readonly unknown[];
    };

    expect(registry.schemaVersion).toBe(
      "scr.runtime-candidate-trusted-keys/v1",
    );
    expect(registry.keys).toEqual([]);
    expect(configText).not.toContain("runtime-candidate-trusted-keys.json");
    expect(manager).toContain("enabled: self.is_enabled()");
    expect(manager).toContain(
      "No trusted Runtime candidate signing keys are provisioned.",
    );
  });

  it("re-verifies the managed slot, commits only a matching cutover, and exposes generated permissions", async () => {
    const [shell, owner, manager, supervisor, capability, build, packager] =
      await Promise.all([
        text("apps/desktop-tauri/src-tauri/src/lib.rs"),
        text("apps/desktop-tauri/src-tauri/src/runtime_candidate_owner.rs"),
        text("apps/desktop-tauri/src-tauri/src/runtime_candidate_update.rs"),
        text("apps/desktop-tauri/src-tauri/src/runtime_host_supervisor.rs"),
        text("apps/desktop-tauri/src-tauri/capabilities/main.json"),
        text("apps/desktop-tauri/src-tauri/build.rs"),
        text("apps/desktop-tauri/scripts/create-runtime-candidate.mjs"),
      ]);

    expect(shell).toContain("mod runtime_candidate_update;");
    expect(shell).toContain("app.manage(runtime_updates);");
    expect(shell).toContain("app.manage(runtime_supervisor.clone());");
    expect(owner).toMatch(
      /acquire_transition\(\)[\s\S]*prepare_activation\(&transition,\s*release_id\)[\s\S]*cutover_verified_slot[\s\S]*commit_activation\(&transition,/u,
    );
    for (const command of [
      "runtime_candidate_update_status",
      "install_runtime_candidate_update",
      "activate_runtime_candidate_update",
    ]) {
      expect(shell).toContain(`fn ${command}(`);
      expect(shell).toContain(`${command},`);
      expect(build).toContain(`"${command}"`);
      expect(capability).toContain(`allow-${command.replaceAll("_", "-")}`);
    }

    expect(manager).toContain("validate_package(");
    expect(manager).toContain("validate_committed_cutover_receipt(");
    expect(manager).toContain("fn read_state_file(");
    expect(manager).toContain("fn recover_state_file(");
    expect(manager).toContain("fn validate_slot_inventory(");
    expect(manager).toContain("fn quarantine_stale_staging_slots(");
    expect(manager).toContain("fn quarantine_managed_directory(");
    expect(manager).toContain(
      "Runtime candidate update root may not be a filesystem volume root.",
    );
    expect(manager).not.toContain("remove_dir_all");
    expect(manager).toContain("active_verified_release(");
    expect(manager).toContain("RuntimeCandidateActivationReceipt");
    expect(manager).toContain("RUNTIME_CANDIDATE_OPERATION_FAILED:");
    expect(owner).toContain("pub(crate) fn restore_active_runtime_candidate(");
    expect(owner).toMatch(
      /active_verified_release\(&transition\)[\s\S]*cutover_verified_slot[\s\S]*validate_committed_cutover_receipt/u,
    );
    expect(shell).toMatch(
      /set_rolling_enabled\(runtime_updates\.is_enabled\(\)\)[\s\S]*restore_active_runtime_candidate[\s\S]*RuntimeHostEndpoint::new/u,
    );
    expect(packager).toContain("function normalizeCandidateOptions(");
    expect(packager).toMatch(
      /createRuntimeCandidate\(options\)[\s\S]*normalizeCandidateOptions\(options\)/u,
    );
    expect(packager).toContain("function cleanupOwnedStaging(");
    expect(packager).toContain("maxRetries: 0");
    expect(packager).toContain(
      "Runtime candidate output may not be a filesystem root or a direct child of one.",
    );
    expect(supervisor).toContain("rolling_enabled: AtomicBool");
    expect(supervisor).toContain("set_rolling_enabled(");
    expect(supervisor).toContain(
      "Signed Runtime candidate cutover is not enabled.",
    );
    expect(shell).toContain(
      "runtime_host_supervisor::cutover_requires_restart(&error)",
    );
    expect(shell).toContain(
      'guardian.prepare_restart("runtime-candidate-authority-unresolved")',
    );
    expect(shell).toContain("app.exit(GUARDIAN_RESTART_EXIT_CODE)");
    expect(supervisor).toContain("fn commit_after_canary");
    expect(supervisor).toContain(
      "resume-active skipped because promoted candidate shutdown was not confirmed.",
    );
    const durableCommit = supervisor.indexOf("commit(&receipt)");
    const nativePublication = supervisor.indexOf(
      "*active_guard = candidate.clone()",
    );
    expect(durableCommit).toBeGreaterThanOrEqual(0);
    expect(nativePublication).toBeGreaterThan(durableCommit);
    expect(owner).toContain(
      "|cutover| manager.commit_activation(&transition, &verified, cutover)",
    );
    expect(packager).toContain("bytes.fill(0)");
  });

  it("keeps the managed candidate audit local and read-only", async () => {
    const [audit, packageJsonText] = await Promise.all([
      text("apps/desktop-tauri/scripts/audit-runtime-candidate-state.mjs"),
      text("apps/desktop-tauri/package.json"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      scripts?: Record<string, string>;
    };

    expect(audit).toContain("auditManagedRuntimeCandidateState");
    expect(audit).toContain(
      "Runtime candidate state and slot inventory disagree.",
    );
    expect(audit).toContain(
      "Runtime candidate inbox and installed slot identities disagree.",
    );
    expect(audit).not.toMatch(
      /\b(?:install|activate|download|fetch|spawn|execFile|exec)\s*\(/u,
    );
    expect(packageJson.scripts?.["runtime:candidate:audit"]).toBe(
      "node scripts/audit-runtime-candidate-state.mjs",
    );
  });

  it("runs both managed audits through one read-only Runtime preflight", async () => {
    const [preflight, packageJsonText] = await Promise.all([
      text("apps/desktop-tauri/scripts/runtime-update-preflight.mjs"),
      text("apps/desktop-tauri/package.json"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      scripts?: Record<string, string>;
    };

    expect(preflight).toContain("auditManagedRuntimeHostReleaseIndex");
    expect(preflight).toContain("auditManagedRuntimeCandidateState");
    expect(preflight).toContain("scr.runtime-managed-update-preflight/v1");
    expect(preflight).not.toMatch(
      /\b(?:install|activate|download|fetch|spawn|execFile|exec)\s*\(/u,
    );
    expect(packageJson.scripts?.["runtime:update:preflight"]).toBe(
      "node scripts/runtime-update-preflight.mjs",
    );
  });

  it("surfaces candidate inventory and actions in Diagnostics while restoring or safely abandoning durable authority at startup", async () => {
    const [view, renderer, shell, owner, manager] = await Promise.all([
      text("apps/desktop/src/renderer/view-settings.ts"),
      text("apps/desktop/src/renderer/main.ts"),
      text("apps/desktop-tauri/src-tauri/src/lib.rs"),
      text("apps/desktop-tauri/src-tauri/src/runtime_candidate_owner.rs"),
      text("apps/desktop-tauri/src-tauri/src/runtime_candidate_update.rs"),
    ]);

    for (const id of [
      "runtime-candidate-meta",
      "runtime-candidate-refresh",
      "runtime-candidate-active",
      "runtime-candidate-trust",
      "runtime-candidate-release",
      "runtime-candidate-install",
      "runtime-candidate-activate",
      "runtime-candidate-detail",
    ]) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(renderer).toContain("renderRuntimeCandidateUpdateStatus(");
    expect(renderer).toContain("refreshRuntimeCandidateUpdateStatus(");
    expect(renderer).toContain("installSelectedRuntimeCandidate(");
    expect(renderer).toContain("activateSelectedRuntimeCandidate(");
    expect(renderer).toMatch(
      /refreshRendererUpdateStatus\(\)[\s\S]*refreshRuntimeCandidateUpdateStatus\(\)[\s\S]*refreshRuntimeRollingStatus\(\)/u,
    );

    expect(shell).toContain("restore_active_runtime_candidate(");
    expect(owner).toContain("manager.active_verified_release(&transition)");
    expect(shell).toContain(".recover_to_built_in(error)");
    expect(shell).toContain("continuing with the built-in Runtime Host");
    expect(manager).toContain("pub(crate) fn active_verified_release(");
    expect(manager).toContain("pub(crate) fn recover_to_built_in(");
    expect(manager).toContain("RUNTIME_CANDIDATE_STARTUP_RECOVERY:");
    expect(manager).toContain("validate_slot_inventory(");
    expect(manager).toContain("recover_state_file(");
  });
});
