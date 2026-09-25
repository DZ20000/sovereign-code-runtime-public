import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

function source(...segments: string[]): string {
  return readFileSync(resolve(root, ...segments), "utf8");
}

function functionBody(text: string, marker: string): string {
  const markerIndex = text.indexOf(marker);
  expect(
    markerIndex,
    `Missing function marker: ${marker}`,
  ).toBeGreaterThanOrEqual(0);
  const openingBrace = text.indexOf("{", markerIndex);
  expect(openingBrace, `Missing body for: ${marker}`).toBeGreaterThan(
    markerIndex,
  );
  let depth = 0;
  for (let index = openingBrace; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openingBrace + 1, index);
    }
  }
  throw new Error(`Unterminated function body: ${marker}`);
}

function expectOrdered(body: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = body.indexOf(marker);
    expect(index, `Missing ordered marker: ${marker}`).toBeGreaterThan(
      previous,
    );
    previous = index;
  }
}

describe("Runtime update owner preflight guards", () => {
  it("revalidates receipted inbox, durable state and slots inside install", () => {
    const manager = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_candidate_update.rs",
    );
    const install = functionBody(manager, "pub(crate) fn install_release(");
    const preflight = functionBody(manager, "fn preflight_snapshot(");
    const precommit = functionBody(manager, "fn assert_install_precommit(");

    expectOrdered(install, [
      "acquire_transition",
      "preflight_install",
      "assert_install_precommit",
      "write_state",
    ]);
    expect(preflight).toContain("read_state_for_preflight");
    expect(preflight).toContain("validate_slot_inventory");
    expect(preflight).toContain("audit_managed_receipts");
    expect(preflight).toContain("validate_package");
    expect(precommit).toContain("preflight_snapshot");
    expect(precommit).toContain("candidate_identities_match");
  });

  it("revalidates managed state before and after Runtime cutover", () => {
    const manager = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_candidate_update.rs",
    );
    const prepare = functionBody(manager, "pub(crate) fn prepare_activation(");
    const commit = functionBody(manager, "pub(crate) fn commit_activation<");

    expectOrdered(prepare, [
      "assert_transition_guard",
      "preflight_snapshot",
      "verified_from_snapshot",
    ]);
    expectOrdered(commit, [
      "assert_transition_guard",
      "preflight_snapshot",
      "verified_from_snapshot",
      "write_state",
    ]);
    expect(commit).toContain("activation identity changed during cutover");
    expect(commit).toContain("state changed during activation cutover");
  });

  it("keeps activation transition ownership and durable commit inside the Tauri shell", () => {
    const shell = source("apps", "desktop-tauri", "src-tauri", "src", "lib.rs");
    const owner = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_candidate_owner.rs",
    );
    const activation = functionBody(
      owner,
      "pub(crate) fn activate_verified_runtime_candidate(",
    );
    const command = functionBody(
      shell,
      "async fn activate_runtime_candidate_update(",
    );

    expectOrdered(activation, [
      "acquire_transition",
      "prepare_activation",
      "cutover_verified_slot",
      "commit_activation",
    ]);
    expect(activation).toContain("prepare_activation(&transition");
    expect(activation).toContain("commit_activation(&transition");
    const restore = functionBody(
      owner,
      "pub(crate) fn restore_active_runtime_candidate(",
    );
    expectOrdered(restore, ["acquire_transition", "active_verified_release"]);
    expect(restore).toContain("active_verified_release(&transition)");
    expect(command).toContain("activate_verified_runtime_candidate");
    expect(command).toContain("cutover_requires_restart");
    expect(command).toContain("runtime-candidate-authority-unresolved");
    const setupRestore = shell.slice(
      shell.indexOf("restore_active_runtime_candidate(&runtime_updates"),
      shell.indexOf("let runtime_endpoint = RuntimeHostEndpoint::new"),
    );
    const startupAbort = functionBody(
      owner,
      "pub(crate) fn startup_restore_requires_abort(",
    );
    expectOrdered(startupAbort, [
      "is_managed_preflight_failure",
      "cutover_requires_restart",
    ]);
    expectOrdered(setupRestore, [
      "startup_restore_requires_abort",
      "recover_to_built_in",
    ]);
    expect(setupRestore).toMatch(
      /startup_restore_requires_abort\(&error\)[\s\S]*return Err/u,
    );
  });

  it("keeps install authority in the manager and exposes only release identity to Renderer", () => {
    const shell = source("apps", "desktop-tauri", "src-tauri", "src", "lib.rs");
    const bridge = source("apps", "desktop-tauri", "src", "bridge.ts");
    const command = functionBody(
      shell,
      "async fn install_runtime_candidate_update(",
    );

    expect(command).toMatch(/manager\s*\.\s*install_release\(&release_id\)/u);
    expect(bridge).toContain(
      "installRuntimeCandidateUpdate: (releaseId: string)",
    );
    expect(bridge).toContain(
      "activateRuntimeCandidateUpdate: (releaseId: string)",
    );
    expect(bridge).not.toMatch(
      /installRuntimeCandidateUpdate\([^)]*(?:path|trust|hash|signature|generation)/iu,
    );
    expect(bridge).not.toMatch(
      /activateRuntimeCandidateUpdate\([^)]*(?:path|trust|hash|signature|generation)/iu,
    );
  });

  it("wires the receipt auditor into the production candidate owner", () => {
    const shell = source("apps", "desktop-tauri", "src-tauri", "src", "lib.rs");
    const manager = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_candidate_update.rs",
    );
    const preflight = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_managed_preflight.rs",
    );

    const constructor = functionBody(manager, "pub(crate) fn new(");
    expect(manager).toContain('#[path = "runtime_managed_preflight.rs"]');
    expectOrdered(constructor, [
      "from_parts_with_policy",
      "CURRENT_RUNTIME_PROTOCOL_VERSION",
      "true",
    ]);
    expect(manager).toContain("audit_managed_receipts");
    expect(manager).toContain("is_managed_preflight_failure(&bounded)");
    expect(preflight).toContain("IMPORT_RECEIPT_SCHEMA_VERSION");
    expect(preflight).toContain("previous_receipt_sha256");
    expect(preflight).toContain("IMPORT_LOCK_DIRECTORY");
    expect(preflight).toContain("direct_file_identity");
  });

  it("requires the target-bound managed preflight in the project workflow", () => {
    const preflight = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "runtime-update-preflight.mjs",
    );
    const skill = source(
      "docs",
      "runtime-candidate-updates.md",
    );

    expect(preflight).toContain("assessRuntimeUpdateReadiness");
    expect(preflight).toContain("operation");
    expect(preflight).toContain("releaseId");
    expect(skill).toContain("--operation <install-or-activate>");
    expect(skill).toContain("--release-id <target-release-id>");
    expect(skill).toContain("Passing preflight does not authorize a cutover");
  });
});
