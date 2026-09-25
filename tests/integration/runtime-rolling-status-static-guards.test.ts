import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

function source(...segments: string[]): string {
  return readFileSync(resolve(root, ...segments), "utf8");
}

describe("Runtime rolling status shell integration", () => {
  it("installs one router-backed service in the Tauri shell and exposes status only", () => {
    const rust = source("apps", "desktop-tauri", "src-tauri", "src", "lib.rs");

    expect(rust).toContain(
      "let runtime_rolling = RuntimeRollingService::new(runtime_router.clone());",
    );
    expect(rust).toContain("app.manage(runtime_router);");
    expect(rust).toContain("app.manage(runtime_rolling);");
    expect(rust).toContain("fn runtime_rolling_status(");
    expect(rust).toContain(
      "State<'_, RuntimeRollingService<RuntimeHostEndpoint>>",
    );
    expect(rust).toContain("runtime_rolling_status,");
    expect(rust).not.toContain("fn runtime_rolling_execute(");

    const supervisor = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_host_supervisor.rs",
    );
    expect(supervisor).toContain("rolling_enabled: AtomicBool");
    expect(supervisor).toContain("set_rolling_enabled(");
    expect(supervisor).toContain(
      "let enabled = self.inner.rolling_enabled.load(Ordering::SeqCst);",
    );
    expect(supervisor).toContain(
      "Signed Runtime candidate cutover is not enabled.",
    );
  });

  it("keeps desktop and preflight control calls on the same endpoint router", () => {
    const rust = source("apps", "desktop-tauri", "src-tauri", "src", "lib.rs");
    const commands = ["control_call", "renderer_preflight_control_call"];

    for (const command of commands) {
      const match = new RegExp(
        `async fn ${command}\\([\\s\\S]*?\\n\\}`,
        "u",
      ).exec(rust);
      expect(match?.[0]).toContain(
        "State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>",
      );
      expect(match?.[0]).toContain("runtime_router.inner().clone()");
      expect(match?.[0]).not.toContain("State<'_, RuntimeHost>");
    }
  });

  it("exposes a read-only renderer bridge and disabled Electron fallback", () => {
    const contract = source(
      "packages",
      "control-plane-contract",
      "src",
      "api.ts",
    );
    const tauriBridge = source("apps", "desktop-tauri", "src", "bridge.ts");
    const electronPreload = source("apps", "desktop", "src", "preload.ts");

    expect(contract).toContain(
      "getRuntimeRollingStatus: () => Promise<DesktopRuntimeRollingStatus>",
    );
    expect(tauriBridge).toContain(
      'invoke<DesktopRuntimeRollingStatus>("runtime_rolling_status")',
    );
    expect(electronPreload).toContain(
      "getRuntimeRollingStatus: () => Promise.resolve(disabledRuntimeRollingStatus)",
    );
    expect(electronPreload).toContain(
      "Runtime Host rolling updates are available in the Tauri shell only.",
    );
    const rollingContract = source(
      "packages",
      "control-plane-contract",
      "src",
      "runtime-rolling.ts",
    );
    expect(rollingContract).toContain("fencingTokenSha256");
    expect(rollingContract).not.toContain("readonly fencingToken:");
  });

  it("surfaces authoritative host, generation, fence digest, and disabled reason in Diagnostics", () => {
    const settings = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "view-settings.ts",
    );
    const renderer = source("apps", "desktop", "src", "renderer", "main.ts");

    for (const id of [
      "runtime-rolling-meta",
      "runtime-rolling-active",
      "runtime-rolling-generation",
      "runtime-rolling-fence",
      "runtime-rolling-detail",
      "runtime-rolling-refresh",
    ]) {
      expect(settings).toContain(`id="${id}"`);
    }
    expect(renderer).toContain("function renderRuntimeRollingStatus(");
    expect(renderer).toContain("refreshRuntimeRollingStatus()");
    expect(renderer).toContain(
      'requiredElement<HTMLButtonElement>("#runtime-rolling-refresh")',
    );
    expect(renderer).toContain("status.disabledReason");
  });
});
