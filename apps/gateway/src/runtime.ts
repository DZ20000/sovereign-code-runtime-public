import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  CAPABILITIES,
  gatewaySessionPolicyFromEnvironment,
  validateGatewaySessionPolicy,
  PolicyEngine,
  RuntimeError,
  SqliteAuditStore,
  SqliteRunStore,
  type AuditReceipt,
  type Capability,
  type GatewaySessionPolicy,
  type RunRecord,
  type RunSummary,
  type RuntimePermissionProfile,
  type ToolManifest,
} from "@sovereign/runtime-core";
import {
  WindowsAdapter,
  type OwnedRuntimeProcess,
} from "@sovereign/windows-adapter";
import {
  createGatewayApplication,
  type GatewayDrainReport,
  type GatewaySessionActivityEvent,
  type GatewaySessionClosedEvent,
  type GatewayToolInputNormalizer,
  type GatewayTrafficStatus,
} from "./app.js";
import {
  createWorkspaceRuntime,
  type GatewayWorkspaceOptions,
  type GatewayWorkspaceRegistration,
  type GatewayWorkspaceRuntime,
  type GatewayWorkspaceSummary,
} from "./runtime-workspace.js";
import type { ToolPackStatus } from "./tool-pack-manager.js";
import { assertGatewayBearerToken } from "./bearer-token.js";

// This is the public MCP/catalog cache identity. Bump it for every wire-visible
// tool or CallToolResult contract change so external connectors must refresh.
export const RUNTIME_VERSION = "0.1.5";
export type {
  GatewayDrainReport,
  GatewaySessionActivityEvent,
  GatewaySessionClosedEvent,
  GatewayToolInputNormalizationRequest,
  GatewayToolInputNormalizer,
  GatewayTrafficStatus,
} from "./app.js";
export type { ToolExecutionActivityEvent } from "@sovereign/toolkit";
export type {
  ExternalToolAuthorizationRequest,
  GatewayRuntimeExtensionContext,
  GatewayRuntimeToolPackFactory,
  GatewayWorkspaceRegistration,
  GatewayWorkspaceSummary,
} from "./runtime-workspace.js";

export interface GatewayRuntimeOptions extends GatewayWorkspaceOptions {
  readonly bearerToken: string;
  readonly workspaceRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly auditPath?: string;
  readonly runPath?: string;
  readonly nativeAgentPath?: string;
  readonly runCompletionNotificationsEnabled?: boolean;
  readonly gatewaySessionPolicy?: GatewaySessionPolicy;
  readonly principalId?: string;
  readonly internalPrincipalId?: string;
  readonly capabilities?: readonly Capability[];
  readonly internalCapabilities?: readonly Capability[];
  readonly externalPermissionProfile?: RuntimePermissionProfile;
  /**
   * Extra workspace ids the external connection may address beyond its own.
   * Fixed when the Gateway starts: a connection's reach is decided once, so
   * authorizing another directory applies to connections made after it.
   */
  readonly reachableWorkspaceIds?: readonly string[];
  readonly normalizeExternalToolInput?: GatewayToolInputNormalizer;
  readonly onExternalSessionActivity?: (
    event: GatewaySessionActivityEvent,
  ) => void;
  readonly onExternalSessionClosed?: (event: GatewaySessionClosedEvent) => void;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly toolPackConfigPath?: string;
  readonly serenaProfilePath?: string;
}

export interface GatewayRuntimeHandle {
  readonly runtimeVersion: string;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly workspaceRoot: string;
  readonly activeWorkspaceId: string;
  readonly gatewaySessionPolicy: GatewaySessionPolicy;
  readonly manifest: ToolManifest;
  readonly manifestForWorkspace: (workspaceId?: string) => ToolManifest;
  readonly registerWorkspace: (
    workspace: GatewayWorkspaceRegistration,
  ) => Promise<void>;
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly workspaces: () => readonly GatewayWorkspaceSummary[];
  readonly resolveToolWorkspaceId: (
    toolName: string,
    input: unknown,
    workspaceId?: string,
  ) => string;
  readonly sessionCount: () => number;
  readonly trafficStatus: () => GatewayTrafficStatus;
  readonly quiesceTraffic: () => GatewayTrafficStatus;
  readonly resumeTraffic: (expectedGeneration: number) => GatewayTrafficStatus;
  readonly waitForTrafficIdle: (
    expectedGeneration: number,
    timeoutMs: number,
  ) => Promise<GatewayDrainReport>;
  readonly externalPermissionProfile: (
    workspaceId?: string,
  ) => RuntimePermissionProfile;
  readonly setExternalPermissionProfile: (
    profile: RuntimePermissionProfile,
    workspaceId?: string,
  ) => void;
  readonly listAuditReceipts: (limit?: number) => readonly AuditReceipt[];
  readonly listRuns: (
    limit?: number,
    workspaceId?: string,
  ) => readonly RunSummary[];
  readonly getRun: (runId: string) => RunRecord;
  readonly cancelRun: (runId: string) => RunRecord;
  readonly listOwnedProcesses: () => readonly OwnedRuntimeProcess[];
  readonly invokeTool: (
    toolName: string,
    input: unknown,
    workspaceId?: string,
  ) => Promise<unknown>;
  readonly toolPacks: () => ToolPackStatus;
  readonly reloadToolPacks: () => Promise<ToolPackStatus>;
  readonly configureToolPacks: (
    enabled: readonly string[],
  ) => Promise<ToolPackStatus>;
  readonly stop: () => Promise<void>;
}

function assertLoopbackHost(host: string): void {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new RuntimeError(
      "HOST_DENIED",
      "The Gateway must remain bound to a loopback address.",
      500,
    );
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RuntimeError(
      "INTERNAL_ERROR",
      "Gateway port must be from 0 through 65535.",
      500,
    );
  }
}

async function allocateLoopbackPort(host: string): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new RuntimeError(
      "INTERNAL_ERROR",
      "Could not allocate a local Gateway port.",
      500,
    );
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
  return address.port;
}

async function listen(
  server: HttpServer,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return;
  }
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

export async function startGatewayRuntime(
  options: GatewayRuntimeOptions,
): Promise<GatewayRuntimeHandle> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  assertGatewayBearerToken(options.bearerToken);

  const gatewaySessionPolicy =
    options.gatewaySessionPolicy === undefined
      ? gatewaySessionPolicyFromEnvironment(process.env)
      : validateGatewaySessionPolicy(options.gatewaySessionPolicy);

  const requestedPort = options.port ?? 3210;
  assertPort(requestedPort);
  const port =
    requestedPort === 0 ? await allocateLoopbackPort(host) : requestedPort;

  const initialRoot = resolve(options.workspaceRoot);
  const initialId = options.workspaceId ?? "default";
  const auditPath = resolve(
    options.auditPath ?? join(initialRoot, ".scr", "audit.sqlite"),
  );
  const runPath = resolve(
    options.runPath ?? join(dirname(auditPath), "runs.sqlite"),
  );
  const toolPackConfigPath = resolve(
    options.toolPackConfigPath ?? join(dirname(auditPath), "tool-packs.json"),
  );
  const profilePath = resolve(
    options.serenaProfilePath ?? join(dirname(auditPath), "semantic-code"),
  );
  const policy = new PolicyEngine();
  const audit = new SqliteAuditStore(auditPath);
  const runStore = new SqliteRunStore(runPath);
  const adapter = new WindowsAdapter({
    workspaces: [],
    policy,
    audit,
    runStore,
    runCompletionNotifierOptions: {
      enabled: options.runCompletionNotificationsEnabled ?? true,
    },
    ...(options.nativeAgentPath === undefined
      ? {}
      : { nativeAgentPath: options.nativeAgentPath }),
  });
  const contexts = new Map<string, GatewayWorkspaceRuntime>();
  let activeWorkspaceId = initialId;
  let stopped = false;
  let registrations: Promise<void> = Promise.resolve();
  const getWorkspace = (id = activeWorkspaceId): GatewayWorkspaceRuntime => {
    const context = contexts.get(id);
    if (context === undefined) {
      throw new RuntimeError(
        "WORKSPACE_NOT_FOUND",
        `Unknown workspace: ${id}`,
        404,
      );
    }
    return context;
  };
  const registerWorkspace = (
    workspace: GatewayWorkspaceRegistration,
  ): Promise<void> => {
    const operation = async (): Promise<void> => {
      if (stopped)
        throw new RuntimeError(
          "INTERNAL_ERROR",
          "The Gateway has stopped.",
          503,
        );
      const root = await adapter.registerWorkspace(workspace);
      if (contexts.has(workspace.id)) return;
      const initial = workspace.id === initialId;
      const directoryId = createHash("sha256")
        .update(workspace.id)
        .digest("hex");
      const context = await createWorkspaceRuntime({
        options: initial
          ? options
          : {
              ...options,
              additionalToolDefinitions: [],
              additionalToolPacks: [],
            },
        // Only the served catalog reaches beyond itself; a registered
        // workspace stays bound to its own directory.
        ...(initial
          ? {
              reachableWorkspaceIds: options.reachableWorkspaceIds ?? [],
              // A workspace that is not registered yet, or no longer, resolves
              // to the most restrictive profile rather than throwing into a
              // tool call.
              externalProfileFor: (id: string) =>
                contexts.get(id)?.externalPermissionProfile ?? "observe",
            }
          : {}),
        workspace: { ...workspace, root },
        audit,
        adapter,
        policy,
        runtimeVersion: RUNTIME_VERSION,
        principalId: options.principalId ?? "local-owner",
        internalPrincipalId:
          options.internalPrincipalId ?? options.principalId ?? "local-owner",
        externalCapabilities: options.capabilities ?? CAPABILITIES,
        internalCapabilities: options.internalCapabilities ?? CAPABILITIES,
        profilePath: initial
          ? profilePath
          : join(profilePath, "workspaces", directoryId),
        toolPackConfigPath: initial
          ? toolPackConfigPath
          : join(
              dirname(toolPackConfigPath),
              "workspaces",
              directoryId,
              basename(toolPackConfigPath),
            ),
      });
      contexts.set(workspace.id, context);
    };
    const result = registrations.then(operation, operation);
    registrations = result.catch(() => undefined);
    return result;
  };
  const stopContexts = async (): Promise<void> => {
    await registrations;
    await Promise.all([...contexts.values()].map((context) => context.stop()));
  };
  try {
    await registerWorkspace({
      id: initialId,
      root: initialRoot,
      label: options.workspaceLabel ?? "Desktop workspace",
      externalPermissionProfile: options.externalPermissionProfile ?? "observe",
    });
  } catch (error) {
    await stopContexts();
    await adapter.shutdown();
    audit.close();
    throw error;
  }
  // External sessions, including future initializations, retain their original
  // principal and catalog when the desktop changes its selected workspace.
  const initial = getWorkspace(initialId);
  const { catalog, principal } = initial;

  const allowedHosts =
    options.allowedHosts === undefined || options.allowedHosts.length === 0
      ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
      : options.allowedHosts;
  const allowedOrigins =
    options.allowedOrigins === undefined || options.allowedOrigins.length === 0
      ? [
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
        ]
      : options.allowedOrigins;

  const gateway = createGatewayApplication({
    runtimeVersion: RUNTIME_VERSION,
    catalog,
    bearerGrants: [{ token: options.bearerToken, principal }],
    allowedHosts,
    allowedOrigins,
    ...gatewaySessionPolicy,
    ...(options.onExternalSessionActivity === undefined
      ? {}
      : { onSessionActivity: options.onExternalSessionActivity }),
    ...(options.onExternalSessionClosed === undefined
      ? {}
      : { onSessionClosed: options.onExternalSessionClosed }),
    ...(options.normalizeExternalToolInput === undefined
      ? {}
      : { normalizeToolInput: options.normalizeExternalToolInput }),
  });
  const server = createHttpServer(gateway.app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  try {
    await listen(server, port, host);
  } catch (error) {
    await stopContexts();
    await gateway.close();
    await adapter.shutdown();
    audit.close();
    throw error;
  }

  const runWorkspace = (runId: string): GatewayWorkspaceRuntime => {
    const run = runStore.get(runId);
    if (run === null)
      throw new RuntimeError(
        "RUN_NOT_FOUND",
        "The requested run was not found.",
        404,
      );
    return getWorkspace(run.workspaceId);
  };
  const resolveToolWorkspaceId = (
    toolName: string,
    input: unknown,
    workspaceId?: string,
  ): string => {
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const explicit =
      workspaceId ??
      (typeof record.workspaceId === "string" ? record.workspaceId : undefined);
    let owner: string | null = null;
    if (toolName.startsWith("runs.") && typeof record.runId === "string")
      owner = runWorkspace(record.runId).id;
    if (
      toolName.startsWith("terminal.session.") &&
      typeof record.sessionId === "string"
    )
      owner = adapter.terminalSessionWorkspaceId(record.sessionId);
    if (toolName.startsWith("browser.") && typeof record.sessionId === "string")
      owner = adapter.browserSessionWorkspaceId(record.sessionId);
    if (owner !== null && explicit !== undefined && owner !== explicit) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "The resource belongs to a different workspace.",
        403,
      );
    }
    return getWorkspace(owner ?? explicit ?? activeWorkspaceId).id;
  };
  return {
    runtimeVersion: RUNTIME_VERSION,
    host,
    port,
    endpoint: `http://${host}:${port}/mcp`,
    get workspaceRoot() {
      return getWorkspace().root;
    },
    get activeWorkspaceId() {
      return activeWorkspaceId;
    },
    gatewaySessionPolicy,
    get manifest(): ToolManifest {
      return catalog.manifest;
    },
    manifestForWorkspace: (id) => getWorkspace(id).internalCatalog.manifest,
    registerWorkspace,
    selectWorkspace(id) {
      getWorkspace(id);
      activeWorkspaceId = id;
    },
    workspaces: () =>
      [...contexts.values()].map(
        ({ id, root, label, externalPermissionProfile }) => ({
          id,
          root,
          label,
          externalPermissionProfile,
        }),
      ),
    resolveToolWorkspaceId,
    sessionCount: gateway.sessionCount,
    trafficStatus: gateway.trafficStatus,
    quiesceTraffic: gateway.quiesce,
    resumeTraffic: gateway.resume,
    waitForTrafficIdle: gateway.waitForIdle,
    externalPermissionProfile: (id) =>
      getWorkspace(id).externalPermissionProfile,
    setExternalPermissionProfile(profile, id) {
      getWorkspace(id).externalPermissionProfile = profile;
    },
    listAuditReceipts: (limit = 100) => audit.list(limit),
    listRuns(limit = 100, id) {
      const context = getWorkspace(id);
      return adapter.listRuns(context.internalPrincipal, context.id, limit);
    },
    getRun(runId) {
      const context = runWorkspace(runId);
      return adapter.getRun(context.internalPrincipal, context.id, runId);
    },
    cancelRun(runId) {
      const context = runWorkspace(runId);
      return adapter.cancelRun(context.internalPrincipal, context.id, runId);
    },
    listOwnedProcesses: () => adapter.ownedProcesses(),
    async invokeTool(toolName, input, id) {
      const context = getWorkspace(resolveToolWorkspaceId(toolName, input, id));
      return await context.internalCatalog.invoke(
        toolName,
        { principal: context.internalPrincipal },
        input,
      );
    },
    toolPacks: () => getWorkspace().toolPackManager.status(),
    reloadToolPacks: () => {
      const context = getWorkspace();
      return context.toolPackManager.reload(context.internalPrincipal.id);
    },
    configureToolPacks: (enabled) => {
      const context = getWorkspace();
      return context.toolPackManager.configure(
        enabled,
        context.internalPrincipal.id,
      );
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.all([closeServer(server), gateway.close()]);
      await stopContexts();
      await adapter.shutdown();
      audit.close();
    },
  };
}
