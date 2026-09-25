import { resolve } from "node:path";

import {
  CAPABILITIES,
  type Capability,
  RuntimeError,
} from "@sovereign/runtime-core";

import { RUNTIME_VERSION, startGatewayRuntime } from "./runtime.js";
import { assertGatewayBearerToken } from "./bearer-token.js";

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 3210;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RuntimeError("INTERNAL_ERROR", "SCR_PORT must be an integer from 1 through 65535.", 500);
  }
  return port;
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return fallback;
  }
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  throw new RuntimeError(
    "INTERNAL_ERROR",
    `${name} must be one of 1, true, on, yes, 0, false, off, or no.`,
    500,
  );
}

function parseCsv(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseCapabilities(value: string | undefined): readonly Capability[] {
  if (value === undefined || value.trim().length === 0) {
    return CAPABILITIES;
  }
  const allowed = new Set<Capability>(CAPABILITIES);
  const selected: Capability[] = [];
  for (const item of parseCsv(value)) {
    if (!allowed.has(item as Capability)) {
      throw new RuntimeError("INTERNAL_ERROR", `Unknown capability in SCR_CAPABILITIES: ${item}`, 500);
    }
    selected.push(item as Capability);
  }
  return selected;
}

async function main(): Promise<void> {
  const bearerToken = process.env.SCR_BEARER_TOKEN;
  assertGatewayBearerToken(bearerToken);

  const host = process.env.SCR_HOST ?? "127.0.0.1";
  const port = parsePort(process.env.SCR_PORT);
  const workspaceRoot = resolve(process.env.SCR_WORKSPACE_ROOT ?? process.cwd());
  const configuredHosts = parseCsv(process.env.SCR_ALLOWED_HOSTS);
  const configuredOrigins = parseCsv(process.env.SCR_ALLOWED_ORIGINS);

  const runtime = await startGatewayRuntime({
    bearerToken,
    workspaceRoot,
    host,
    port,
    principalId: process.env.SCR_PRINCIPAL_ID ?? "local-owner",
    capabilities: parseCapabilities(process.env.SCR_CAPABILITIES),
    runCompletionNotificationsEnabled: parseBoolean(
      process.env.SCR_RUN_COMPLETION_NOTIFICATIONS,
      "SCR_RUN_COMPLETION_NOTIFICATIONS",
      true,
    ),
    ...(process.env.SCR_AUDIT_DB === undefined
      ? {}
      : { auditPath: process.env.SCR_AUDIT_DB }),
    ...(configuredHosts.length === 0 ? {} : { allowedHosts: configuredHosts }),
    ...(configuredOrigins.length === 0 ? {} : { allowedOrigins: configuredOrigins }),
  });

  console.error(
    JSON.stringify({
      event: "listening",
      runtimeVersion: RUNTIME_VERSION,
      host: runtime.host,
      port: runtime.port,
      endpoint: runtime.endpoint,
      manifestDigest: runtime.manifest.digest,
      workspaceRoot: runtime.workspaceRoot,
    }),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(JSON.stringify({ event: "shutdown", signal }));
    await runtime.stop();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(JSON.stringify({ event: "fatal", message }));
  process.exitCode = 1;
});
