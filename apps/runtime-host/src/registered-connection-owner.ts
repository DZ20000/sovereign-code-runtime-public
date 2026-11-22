import type { ControlPlaneControllerOptions } from "@sovereign/control-plane";
import { refreshRegisteredGeminiConnection } from "@sovereign/gateway/runtime";

export const REGISTERED_CONNECTION_OWNER_ENV = "SCR_RUNTIME_REGISTERED_CONNECTION_OWNER";

const ISOLATED_ENVIRONMENT_KEYS = new Set([
  "SCR_USER_DATA_PATH",
  "SCR_SMOKE_REPORT_PATH",
  "SCR_APPROVAL_SMOKE_REPORT_PATH",
  "SCR_HOST_GUARDIAN_INTEGRATION_DIR",
]);

/** Consume the launcher's one-hop opt-in before any Runtime Host child can inherit it. */
export function consumeRegisteredConnectionOwnerOptions(
  environment: NodeJS.ProcessEnv,
): Pick<ControlPlaneControllerOptions, "onAuthoritativeGatewayConnection"> {
  let enabled = false;
  let isolated = false;
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toUpperCase();
    if (key === REGISTERED_CONNECTION_OWNER_ENV) {
      delete environment[name];
      if (value === "1") enabled = true;
      else if (value !== undefined) isolated = true;
    } else if (
      value !== undefined &&
      (ISOLATED_ENVIRONMENT_KEYS.has(key) ||
        key.startsWith("SCR_RESOURCE_BENCHMARK_") ||
        key.startsWith("SCR_UPDATE_PREFLIGHT"))
    ) {
      isolated = true;
    }
  }
  if (!enabled || isolated) return {};
  return {
    onAuthoritativeGatewayConnection: async (endpoint, bearerToken) => {
      await refreshRegisteredGeminiConnection(
        endpoint, bearerToken, environment, AbortSignal.timeout(8_000),
      );
    },
  };
}
