import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createPrincipal,
  permissionProfileAllows,
  RuntimeError,
  toPublicRuntimeError,
  type AuditStore,
  type Capability,
  type Principal,
  type PolicyEngine,
  type RuntimePermissionProfile,
  type SqliteAuditStore,
  type ToolSpec,
} from "@sovereign/runtime-core";
import {
  ToolCatalog,
  createBuiltinTools,
  createDeveloperEssentialsToolPack,
  defineTool,
  objectSchema,
  type RuntimeToolDefinition,
  type RuntimeToolPack,
  type ToolExecutionActivityHook,
  type ToolRejectionRequest,
} from "@sovereign/toolkit";
import type { WindowsAdapter } from "@sovereign/windows-adapter";
import {
  CapabilityDirectory,
  createCapabilityDirectoryTools,
} from "./capability-directory.js";
import { createSemanticCodeToolPack } from "./semantic-code-pack.js";
import {
  SERENA_REVIEWED_VERSION,
  SerenaSemanticManager,
} from "./serena-manager.js";
import { ToolPackManager, type ToolPackStatus } from "./tool-pack-manager.js";

export interface ExternalToolAuthorizationRequest {
  readonly profile: RuntimePermissionProfile;
  readonly principal: Principal;
  readonly spec: ToolSpec;
  readonly input: Readonly<Record<string, unknown>>;
}
export interface GatewayRuntimeExtensionContext {
  readonly audit: AuditStore;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}
export type GatewayRuntimeToolPackFactory = (
  context: GatewayRuntimeExtensionContext,
) => RuntimeToolPack;
export interface GatewayWorkspaceOptions {
  readonly authorizeExternalTool?: (
    request: ExternalToolAuthorizationRequest,
  ) => Promise<boolean> | boolean;
  readonly onExternalToolActivity?: ToolExecutionActivityHook;
  readonly onExternalToolRejected?: () => Promise<void> | void;
  readonly additionalToolDefinitions?: readonly RuntimeToolDefinition[];
  readonly additionalToolDefinitionsFactory?: (
    context: Omit<GatewayRuntimeExtensionContext, "audit">,
  ) => readonly RuntimeToolDefinition[];
  readonly additionalToolPacks?: readonly RuntimeToolPack[];
  readonly additionalToolPackFactories?: readonly GatewayRuntimeToolPackFactory[];
  readonly watchToolPacks?: boolean;
  readonly onToolPacksChanged?: (status: ToolPackStatus) => void;
  readonly serenaExecutablePath?: string;
  readonly serenaExpectedVersion?: string | null;
  readonly serenaServerArguments?: readonly string[];
}
export interface GatewayWorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly label?: string;
  readonly externalPermissionProfile?: RuntimePermissionProfile;
}
export interface GatewayWorkspaceSummary {
  readonly id: string;
  readonly root: string;
  readonly label: string;
  readonly externalPermissionProfile: RuntimePermissionProfile;
}
export interface GatewayWorkspaceRuntime {
  readonly id: string;
  readonly root: string;
  readonly label: string;
  readonly principal: Principal;
  readonly internalPrincipal: Principal;
  externalPermissionProfile: RuntimePermissionProfile;
  readonly catalog: ToolCatalog;
  readonly internalCatalog: ToolCatalog;
  readonly toolPackManager: ToolPackManager;
  readonly stop: () => Promise<void>;
}

function appendToolRejection(
  audit: SqliteAuditStore,
  request: ToolRejectionRequest,
): void {
  const candidateWorkspaceId = request.input?.workspaceId;
  audit.append({
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    principalId: request.principal.id,
    toolName: request.toolName,
    operation: `catalog.${request.stage}`,
    outcome: request.error.code === "POLICY_DENIED" ? "denied" : "failed",
    ...(typeof candidateWorkspaceId === "string" &&
    candidateWorkspaceId.length > 0
      ? { workspaceId: candidateWorkspaceId }
      : {}),
    errorCode: request.error.code,
    details: {
      stage: request.stage,
      status: request.error.status,
      ...(request.spec === undefined
        ? {}
        : {
            permissionLevel: request.spec.permissionLevel,
            approvalMode: request.spec.approvalMode,
            requiredCapabilities: request.spec.requiredCapabilities,
          }),
      ...(request.error.details === undefined
        ? {}
        : { errorDetails: request.error.details }),
      inputKeys:
        request.input === undefined ? [] : Object.keys(request.input).sort(),
    },
  });
}

function bindDefinitionsToWorkspace(
  definitions: readonly RuntimeToolDefinition[],
  workspaceId: string,
  reachableWorkspaceIds: readonly string[] = [workspaceId],
): readonly RuntimeToolDefinition[] {
  const reachable = new Set(reachableWorkspaceIds);
  return definitions.map((definition) => {
    if (!("workspaceId" in definition.inputShape)) {
      return definition;
    }
    const inputSchema = definition.spec.inputSchema;
    const properties =
      inputSchema.properties !== null &&
      typeof inputSchema.properties === "object" &&
      !Array.isArray(inputSchema.properties)
        ? (inputSchema.properties as Readonly<Record<string, unknown>>)
        : {};
    const required = Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((entry) => entry !== "workspaceId")
      : [];
    const publicProperties = {
      ...properties,
      workspaceId: {
        type: "string",
        default: workspaceId,
        description: "Optional; this connection binds its authorized workspace automatically.",
      },
    };
    return {
      ...definition,
      spec: {
        ...definition.spec,
        description: `${definition.spec.description} The workspace authorized for this connection is bound automatically.`,
        inputSchema: {
          ...inputSchema,
          properties: publicProperties,
          required,
        },
      },
      inputShape: {
        ...definition.inputShape,
        workspaceId: z.string().min(1).max(128).optional().default(workspaceId),
      },
      parse(input): Record<string, unknown> {
        // A client may name any workspace the operator authorized for this
        // connection; anything else silently becomes the bound one rather than
        // failing, so an unknown id can never widen reach.
        const requested =
          input !== null && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>).workspaceId
            : undefined;
        const selected =
          typeof requested === "string" && reachable.has(requested)
            ? requested
            : workspaceId;
        const normalized =
          input !== null && typeof input === "object" && !Array.isArray(input)
            ? { ...(input as Record<string, unknown>), workspaceId: selected }
            : input;
        return definition.parse(normalized);
      },
      workspaceId: () => workspaceId,
    };
  });
}

function bindToolPackToWorkspace(
  pack: RuntimeToolPack,
  workspaceId: string,
): RuntimeToolPack {
  return {
    ...pack,
    definitions: bindDefinitionsToWorkspace(pack.definitions, workspaceId),
  };
}

function createToolPackControlTools(
  status: () => ToolPackStatus,
  reload: (principalId: string) => Promise<ToolPackStatus>,
  configure: (
    enabled: readonly string[],
    principalId: string,
  ) => Promise<ToolPackStatus>,
): readonly RuntimeToolDefinition[] {
  return [
    defineTool(
      {
        name: "system.tool_packs",
        version: "1.0.0",
        title: "Tool-pack status",
        description:
          "Return the bounded installed tool-pack registry, active generation, manifest digest, and last hot-reload result.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      () => status(),
    ),
    defineTool(
      {
        name: "system.tool_packs.reload",
        version: "1.0.0",
        title: "Reload tool packs",
        description:
          "Re-read the local declarative tool-pack registry and atomically publish a changed tool manifest without restarting the Gateway.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({}, []),
      },
      {},
      ({ principal }) => reload(principal.id),
    ),
    defineTool(
      {
        name: "system.tool_packs.configure",
        version: "1.0.0",
        title: "Configure tool packs",
        description:
          "Enable the exact bounded set of reviewed tool packs and publish the resulting tool manifest without restarting the Gateway.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          enabled: {
            type: "array",
            maxItems: 32,
            items: {
              type: "string",
              pattern: "^[a-z][a-z0-9-]{0,63}$",
            },
          },
        }),
      },
      {
        enabled: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).max(32),
      },
      ({ principal }, input) => configure(input.enabled, principal.id),
    ),
  ];
}

export async function createWorkspaceRuntime(input: {
  readonly options: GatewayWorkspaceOptions;
  readonly workspace: GatewayWorkspaceRegistration;
  readonly audit: SqliteAuditStore;
  readonly adapter: WindowsAdapter;
  readonly policy: PolicyEngine;
  readonly runtimeVersion: string;
  readonly principalId: string;
  readonly internalPrincipalId: string;
  readonly externalCapabilities: readonly Capability[];
  readonly internalCapabilities: readonly Capability[];
  readonly profilePath: string;
  readonly toolPackConfigPath: string;
  /**
   * Workspaces this context's external connection may address, its own
   * included. A connection reaches only the directories the operator
   * authorized for it, and the set is fixed for the connection's life so a
   * desktop change cannot move a live session's reach.
   */
  readonly reachableWorkspaceIds?: readonly string[];
  /**
   * The external profile of the workspace a call targets. Authority belongs to
   * the directory being written, not to the catalog that served the tool, so a
   * reachable workspace at a lower level cannot be reached through a higher one.
   */
  readonly externalProfileFor?: (workspaceId: string) => RuntimePermissionProfile;
}): Promise<GatewayWorkspaceRuntime> {
  const {
    options,
    workspace,
    audit,
    adapter,
    policy,
    runtimeVersion,
    profilePath,
    toolPackConfigPath,
  } = input;
  const workspaceId = workspace.id;
  const workspaceRoot = workspace.root;
  const reachableWorkspaceIds = [
    ...new Set([workspaceId, ...(input.reachableWorkspaceIds ?? [])]),
  ];
  const principal = createPrincipal(
    input.principalId,
    input.externalCapabilities,
    reachableWorkspaceIds,
  );
  const internalPrincipal = createPrincipal(
    input.internalPrincipalId,
    input.internalCapabilities,
    [workspaceId],
  );
  const capabilityDirectory = new CapabilityDirectory({ audit });
  const semanticCode = new SerenaSemanticManager({
    workspaceRoot,
    profileRoot: resolve(profilePath),
    ...(options.serenaExecutablePath === undefined
      ? {}
      : { executablePath: options.serenaExecutablePath }),
    expectedExecutableVersion:
      options.serenaExpectedVersion === undefined
        ? options.serenaExecutablePath === undefined
          ? SERENA_REVIEWED_VERSION
          : null
        : options.serenaExpectedVersion,
    ...(options.serenaServerArguments === undefined
      ? {}
      : { serverArguments: options.serenaServerArguments }),
  });
  const context = {
    externalPermissionProfile: workspace.externalPermissionProfile ?? "observe",
  };
  // An unresolvable target falls to the most restrictive answer rather than to
  // this context's own, so a missing lookup cannot hand out authority.
  const resolveExternalProfile = (id: string): RuntimePermissionProfile =>
    id === workspaceId
      ? context.externalPermissionProfile
      : (input.externalProfileFor?.(id) ?? "observe");
  let factoryPacks: readonly RuntimeToolPack[];
  try {
    factoryPacks = (options.additionalToolPackFactories ?? []).map((factory) =>
      factory({
        audit,
        workspaceId,
        workspaceRoot,
      }),
    );
  } catch (error) {
    await semanticCode.stop();
    throw error;
  }
  let toolPackManager: ToolPackManager | null = null;
  const toolPackStatus = (): ToolPackStatus => {
    if (toolPackManager === null) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        "The tool-pack manager is still initializing.",
        503,
      );
    }
    return toolPackManager.status();
  };
  const reloadToolPacks = async (
    principalId = internalPrincipal.id,
  ): Promise<ToolPackStatus> => {
    if (toolPackManager === null) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        "The tool-pack manager is still initializing.",
        503,
      );
    }
    return await toolPackManager.reload(principalId);
  };
  const configureToolPacks = async (
    enabled: readonly string[],
    principalId = internalPrincipal.id,
  ): Promise<ToolPackStatus> => {
    if (toolPackManager === null) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        "The tool-pack manager is still initializing.",
        503,
      );
    }
    return await toolPackManager.configure(enabled, principalId);
  };
  const baseDefinitions = bindDefinitionsToWorkspace(
    [
      ...createBuiltinTools(adapter),
      ...createCapabilityDirectoryTools(capabilityDirectory),
      ...(options.additionalToolDefinitions ?? []),
      ...(options.additionalToolDefinitionsFactory?.({
        workspaceId,
        workspaceRoot,
      }) ?? []),
      ...createToolPackControlTools(
        toolPackStatus,
        reloadToolPacks,
        configureToolPacks,
      ),
    ],
    workspaceId,
    reachableWorkspaceIds,
  );
  const packs = [
    bindToolPackToWorkspace(
      createDeveloperEssentialsToolPack(adapter),
      workspaceId,
    ),
    bindToolPackToWorkspace(
      createSemanticCodeToolPack(semanticCode),
      workspaceId,
    ),
    ...(options.additionalToolPacks ?? []).map((pack) =>
      bindToolPackToWorkspace(pack, workspaceId),
    ),
    ...factoryPacks.map((pack) => bindToolPackToWorkspace(pack, workspaceId)),
  ];
  const catalog = new ToolCatalog(
    baseDefinitions,
    policy,
    runtimeVersion,
    async ({ principal: callPrincipal, spec, input }) => {
      // Authority belongs to the directory a call targets. Reading it from the
      // serving context instead would let a reachable workspace be written
      // through another one's higher level.
      const target =
        typeof input?.workspaceId === "string" ? input.workspaceId : workspaceId;
      const targetProfile = resolveExternalProfile(target);
      if (!permissionProfileAllows(targetProfile, spec.permissionLevel)) {
        throw new RuntimeError(
          "POLICY_DENIED",
          `External permission profile ${targetProfile} does not allow ${spec.permissionLevel} tools.`,
          403,
          {
            layer: "sovereign.permission-profile",
            profile: targetProfile,
            requiredLevel: spec.permissionLevel,
            toolName: spec.name,
            workspaceId: target,
          },
        );
      }

      if (
        targetProfile === "consequential" &&
        spec.permissionLevel === "consequential"
      ) {
        if (options.authorizeExternalTool === undefined) {
          throw new RuntimeError(
            "POLICY_DENIED",
            "This tool requires Sovereign local approval, but no local approval broker is available.",
            403,
            {
              toolName: spec.name,
              layer: "sovereign.local-approval",
              reason: "broker-unavailable",
            },
          );
        }
        const approved = await options.authorizeExternalTool({
          profile: targetProfile,
          principal: callPrincipal,
          spec,
          input,
        });
        if (!approved) {
          throw new RuntimeError(
            "POLICY_DENIED",
            "Sovereign local approval was not granted. The approval may have been denied, cancelled, or expired; no specific reason was returned.",
            403,
            {
              toolName: spec.name,
              layer: "sovereign.local-approval",
              reason: "approval-not-granted",
            },
          );
        }
      }
    },
    async (request) => {
      appendToolRejection(audit, request);
      await options.onExternalToolRejected?.();
    },
    options.onExternalToolActivity,
  );
  const internalCatalog = new ToolCatalog(
    baseDefinitions,
    policy,
    runtimeVersion,
    undefined,
    (request) => appendToolRejection(audit, request),
  );

  toolPackManager = new ToolPackManager({
    configPath: resolve(toolPackConfigPath),
    baseDefinitions,
    packs,
    catalogs: [catalog, internalCatalog],
    audit,
    ...(options.watchToolPacks === undefined
      ? {}
      : { watch: options.watchToolPacks }),
    onChanged: (status) => {
      if (!status.enabled.includes("semantic-code")) {
        void semanticCode.deactivate();
      }
      options.onToolPacksChanged?.(status);
    },
  });
  capabilityDirectory.bind({
    definitions: () => catalog.definitions,
    manifest: () => catalog.manifest,
    toolPacks: () => toolPackManager!.status(),
    describeAuthorization: (callContext, definition) => {
      // Desktop calls are approved by their controller before the internal catalog.
      if (callContext.principal === internalPrincipal) return null;
      let policyDenial = null;
      try {
        policy.require(
          callContext.principal,
          definition.spec.requiredCapabilities,
          "workspaceId" in definition.inputShape ? workspaceId : undefined,
        );
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        policyDenial = toPublicRuntimeError(error);
      }
      const profile = context.externalPermissionProfile;
      const profileAllowsTool = permissionProfileAllows(
        profile,
        definition.spec.permissionLevel,
      );
      return {
        workspaceId,
        permissionProfile: profile,
        profileAllowsTool,
        policyDenial,
        localApproval:
          policyDenial !== null || !profileAllowsTool
            ? "blocked"
            : profile === "consequential" && definition.spec.permissionLevel === "consequential"
              ? options.authorizeExternalTool === undefined ? "unavailable" : "broker-required"
              : "not-required",
        clientApproval: "independent",
        taskScope: "not-inferred",
      };
    },
    invoke: (context, toolName, input) => {
      const targetCatalog =
        context.principal === internalPrincipal ? internalCatalog : catalog;
      return targetCatalog.invoke(toolName, context, input);
    },
  });
  try {
    await toolPackManager.start();
  } catch (error) {
    await semanticCode.stop();
    throw error;
  }

  return {
    id: workspaceId,
    root: workspaceRoot,
    label: workspace.label ?? "Desktop workspace",
    principal,
    internalPrincipal,
    get externalPermissionProfile() {
      return context.externalPermissionProfile;
    },
    set externalPermissionProfile(profile) {
      context.externalPermissionProfile = profile;
    },
    catalog,
    internalCatalog,
    toolPackManager,
    async stop() {
      await toolPackManager.close();
      await semanticCode.stop();
    },
  };
}
