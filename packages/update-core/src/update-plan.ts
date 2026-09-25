export const COMPONENT_UPDATE_MODES = [
  "no-op",
  "renderer-reload",
  "runtime-rolling",
  "application-restart",
  "maintenance",
] as const;

export type ComponentUpdateMode = (typeof COMPONENT_UPDATE_MODES)[number];

export const COMPONENT_CHANGE_KINDS = ["added", "modified", "removed"] as const;
export type ComponentChangeKind = (typeof COMPONENT_CHANGE_KINDS)[number];

export const DATABASE_MIGRATION_MODES = [
  "none",
  "expand",
  "contract",
  "breaking",
] as const;
export type DatabaseMigrationMode = (typeof DATABASE_MIGRATION_MODES)[number];

export interface UpdateComponentChange {
  readonly path: string;
  readonly role: string;
  readonly change: ComponentChangeKind;
}

export interface ComponentUpdatePolicy {
  readonly allowRendererReload?: boolean;
  readonly allowRuntimeRolling?: boolean;
  readonly databaseMigration?: DatabaseMigrationMode;
  readonly onlineExpandMigration?: boolean;
}

export interface ComponentUpdatePlan {
  readonly mode: ComponentUpdateMode;
  readonly changedRoles: readonly string[];
  readonly reasons: readonly string[];
  readonly phases: readonly string[];
  readonly requiresQuiescence: boolean;
  readonly requiresApplicationRestart: boolean;
  readonly preservesTaskState: boolean;
  readonly rollbackRequired: boolean;
}

type KnownComponentRole =
  | "renderer"
  | "runtime-host"
  | "gateway"
  | "desktop-shell"
  | "preload"
  | "node-runtime"
  | "host-guardian"
  | "native-agent"
  | "database";

const ROLE_ALIASES = new Map<string, KnownComponentRole>([
  ["renderer", "renderer"],
  ["desktop-renderer", "renderer"],
  ["web-assets", "renderer"],
  ["frontend", "renderer"],
  ["runtime-host", "runtime-host"],
  ["runtime", "runtime-host"],
  ["gateway", "gateway"],
  ["mcp-gateway", "gateway"],
  ["desktop-shell", "desktop-shell"],
  ["shell", "desktop-shell"],
  ["tauri-shell", "desktop-shell"],
  ["preload", "preload"],
  ["node-runtime", "node-runtime"],
  ["node", "node-runtime"],
  ["host-guardian", "host-guardian"],
  ["guardian", "host-guardian"],
  ["native-agent", "native-agent"],
  ["native", "native-agent"],
  ["database", "database"],
  ["database-schema", "database"],
]);

const RESTART_ROLES = new Set<KnownComponentRole>([
  "desktop-shell",
  "preload",
  "node-runtime",
  "host-guardian",
  "native-agent",
]);

const RUNTIME_ROLES = new Set<KnownComponentRole>(["runtime-host", "gateway"]);

const PHASES: Readonly<Record<ComponentUpdateMode, readonly string[]>> = {
  "no-op": [],
  "renderer-reload": [
    "verify",
    "stage-renderer",
    "preflight-renderer",
    "capture-view-state",
    "activate-renderer",
    "reload-renderer",
    "restore-view-state",
    "observe",
  ],
  "runtime-rolling": [
    "verify",
    "stage-runtime",
    "start-candidate",
    "preflight-candidate",
    "quiesce-active",
    "drain-in-flight-work",
    "checkpoint-tasks",
    "switch-traffic",
    "canary",
    "commit",
    "retire-previous-runtime",
  ],
  "application-restart": [
    "verify",
    "stage-release",
    "wait-for-safe-point",
    "checkpoint-tasks",
    "restart-application",
    "health-check",
    "restore-state",
  ],
  maintenance: [
    "verify",
    "backup-state",
    "quiesce-all-work",
    "apply-compatible-migration",
    "restart-application",
    "health-check",
    "commit-or-rollback",
  ],
};

function normalizeRole(role: string): KnownComponentRole | null {
  return ROLE_ALIASES.get(role.trim().toLowerCase()) ?? null;
}

function validateChange(change: UpdateComponentChange): void {
  if (
    typeof change.path !== "string" ||
    change.path.length === 0 ||
    change.path.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(change.path)
  ) {
    throw new Error("Update component path must be a bounded printable string.");
  }
  if (
    typeof change.role !== "string" ||
    change.role.trim().length === 0 ||
    change.role.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(change.role)
  ) {
    throw new Error(`Update component ${change.path} has an invalid role.`);
  }
  if (!COMPONENT_CHANGE_KINDS.includes(change.change)) {
    throw new Error(`Update component ${change.path} has an invalid change kind.`);
  }
}

function buildPlan(
  mode: ComponentUpdateMode,
  changedRoles: readonly string[],
  reasons: readonly string[],
): ComponentUpdatePlan {
  return {
    mode,
    changedRoles,
    reasons,
    phases: PHASES[mode],
    requiresQuiescence: ["runtime-rolling", "application-restart", "maintenance"].includes(
      mode,
    ),
    requiresApplicationRestart: ["application-restart", "maintenance"].includes(mode),
    preservesTaskState: mode !== "no-op",
    rollbackRequired: mode !== "no-op",
  };
}

/**
 * Selects the least disruptive safe update strategy for a verified component diff.
 * Unknown component roles deliberately fail closed to an application restart.
 */
export function planComponentUpdate(
  changes: readonly UpdateComponentChange[],
  policy: ComponentUpdatePolicy = {},
): ComponentUpdatePlan {
  if (changes.length > 10_000) {
    throw new Error("Update component diff exceeds the bounded planning limit.");
  }
  changes.forEach(validateChange);

  if (changes.length === 0) {
    return buildPlan("no-op", [], ["The candidate does not change any components."]);
  }

  const normalized = changes.map((change) => ({
    change,
    role: normalizeRole(change.role),
  }));
  const changedRoles = [
    ...new Set(
      normalized.map(({ change, role }) => role ?? `unknown:${change.role.trim().toLowerCase()}`),
    ),
  ].sort();
  const migration = policy.databaseMigration ?? "none";

  if (migration === "breaking" || migration === "contract") {
    return buildPlan("maintenance", changedRoles, [
      `${migration} database migration requires a quiesced, rollback-aware maintenance cutover.`,
    ]);
  }

  const unknown = normalized.filter(({ role }) => role === null);
  if (unknown.length > 0) {
    return buildPlan("application-restart", changedRoles, [
      `Unknown component roles fail closed: ${unknown
        .map(({ change }) => change.role)
        .sort()
        .join(", ")}.`,
    ]);
  }

  const roles = new Set(normalized.map(({ role }) => role!));
  const restartRoles = [...roles].filter((role) => RESTART_ROLES.has(role)).sort();
  if (restartRoles.length > 0) {
    return buildPlan("application-restart", changedRoles, [
      `Native or trust-boundary components require a controlled application restart: ${restartRoles.join(
        ", ",
      )}.`,
    ]);
  }

  if (roles.has("database")) {
    if (migration !== "expand" || policy.onlineExpandMigration !== true) {
      return buildPlan("application-restart", changedRoles, [
        "Database changes require a controlled restart unless an online expand migration is explicitly declared.",
      ]);
    }
  }

  const runtimeRoles = [...roles].filter((role) => RUNTIME_ROLES.has(role)).sort();
  if (runtimeRoles.length > 0 || roles.has("database")) {
    if (policy.allowRuntimeRolling === false) {
      return buildPlan("application-restart", changedRoles, [
        "Runtime rolling cutover is disabled by policy.",
      ]);
    }
    return buildPlan("runtime-rolling", changedRoles, [
      `Runtime-scoped components can use a drain, checkpoint, switch, and canary cutover: ${[
        ...runtimeRoles,
        ...(roles.has("database") ? ["database-expand"] : []),
      ].join(", ")}.`,
    ]);
  }

  if (roles.size === 1 && roles.has("renderer")) {
    if (policy.allowRendererReload === false) {
      return buildPlan("application-restart", changedRoles, [
        "Renderer-only reload is disabled by policy.",
      ]);
    }
    return buildPlan("renderer-reload", changedRoles, [
      "Only immutable renderer assets changed; the active Runtime Host can remain online.",
    ]);
  }

  return buildPlan("application-restart", changedRoles, [
    "The component combination has no narrower proven-safe update strategy.",
  ]);
}
