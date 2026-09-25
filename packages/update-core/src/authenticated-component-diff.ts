import type { VerifiedLayeredUpdateCandidate } from "./layered-update.js";
import type {
  ComponentUpdatePolicy,
  UpdateComponentChange,
} from "./update-plan.js";
import type { RendererCutoverInput } from "./renderer-cutover.js";
import type { RuntimeCutoverInput } from "./runtime-cutover.js";

export interface AuthenticatedUpdateComponent {
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface AuthenticatedComponentInventory {
  readonly manifestSha256: string;
  readonly components: readonly AuthenticatedUpdateComponent[];
}

export interface BuildVerifiedLayeredCandidateInput {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly signingKeyId: string;
  readonly verifiedAt: number;
  readonly previous: AuthenticatedComponentInventory;
  readonly candidate: AuthenticatedComponentInventory;
  readonly policy?: ComponentUpdatePolicy;
  readonly renderer?: Omit<RendererCutoverInput, "cutoverId" | "signal">;
  readonly runtime?: Omit<RuntimeCutoverInput, "cutoverId" | "signal">;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ROLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u;
const MAX_COMPONENTS = 10_000;
const MAX_COMPONENT_BYTES = 2 * 1_024 * 1_024 * 1_024;

interface NormalizedComponent extends AuthenticatedUpdateComponent {
  readonly portableKey: string;
}

function normalizePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`${label} is not a bounded portable relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._@()+,~%-]+$/u.test(segment),
    )
  ) {
    throw new Error(`${label} contains an unsafe or non-portable segment.`);
  }
  return segments.join("/");
}

function normalizeComponent(
  value: AuthenticatedUpdateComponent,
  index: number,
  inventoryLabel: string,
): NormalizedComponent {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${inventoryLabel} component ${index} is invalid.`);
  }
  const path = normalizePath(
    value.path,
    `${inventoryLabel} component ${index} path`,
  );
  if (typeof value.role !== "string" || !ROLE_PATTERN.test(value.role)) {
    throw new Error(`${inventoryLabel} component ${path} role is invalid.`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`${inventoryLabel} component ${path} digest is invalid.`);
  }
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAX_COMPONENT_BYTES
  ) {
    throw new Error(
      `${inventoryLabel} component ${path} byte length is invalid.`,
    );
  }
  return {
    path,
    role: value.role,
    sha256: value.sha256,
    bytes: value.bytes,
    portableKey: path.toLowerCase(),
  };
}

function normalizeInventory(
  inventory: AuthenticatedComponentInventory,
  label: string,
): ReadonlyMap<string, NormalizedComponent> {
  if (typeof inventory !== "object" || inventory === null) {
    throw new Error(`${label} inventory is invalid.`);
  }
  if (
    typeof inventory.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(inventory.manifestSha256)
  ) {
    throw new Error(`${label} manifest digest is invalid.`);
  }
  if (
    !Array.isArray(inventory.components) ||
    inventory.components.length > MAX_COMPONENTS
  ) {
    throw new Error(`${label} component inventory exceeds its bounded limit.`);
  }
  const normalized = new Map<string, NormalizedComponent>();
  inventory.components.forEach((component, index) => {
    const value = normalizeComponent(component, index, label);
    if (normalized.has(value.portableKey)) {
      throw new Error(
        `${label} contains a duplicate portable path: ${value.path}.`,
      );
    }
    normalized.set(value.portableKey, value);
  });
  return normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Computes the component update diff from two authenticated exact inventories.
 * A role change is represented as removal under the old role plus addition
 * under the new role so the planner always selects the more disruptive path.
 */
export function diffAuthenticatedComponentInventories(
  previousInventory: AuthenticatedComponentInventory,
  candidateInventory: AuthenticatedComponentInventory,
): readonly UpdateComponentChange[] {
  const previous = normalizeInventory(previousInventory, "Previous release");
  const candidate = normalizeInventory(candidateInventory, "Candidate release");
  const keys = [...new Set([...previous.keys(), ...candidate.keys()])].sort(
    compareText,
  );
  const changes: UpdateComponentChange[] = [];

  for (const key of keys) {
    const before = previous.get(key);
    const after = candidate.get(key);
    if (before === undefined && after !== undefined) {
      changes.push({ path: after.path, role: after.role, change: "added" });
      continue;
    }
    if (before !== undefined && after === undefined) {
      changes.push({ path: before.path, role: before.role, change: "removed" });
      continue;
    }
    if (before === undefined || after === undefined) continue;

    if (before.path !== after.path) {
      throw new Error(
        `Candidate changed only the case of component path ${before.path}; portable paths must remain case-stable.`,
      );
    }
    if (before.role !== after.role) {
      changes.push({ path: before.path, role: before.role, change: "removed" });
      changes.push({ path: after.path, role: after.role, change: "added" });
      continue;
    }
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
      changes.push({ path: after.path, role: after.role, change: "modified" });
    }
  }

  return changes;
}

/**
 * Builds the only candidate shape accepted by LayeredUpdateCoordinator from
 * authenticated previous/candidate inventories. Signature verification itself
 * remains owned by the existing signed-release verifier.
 */
export function buildVerifiedLayeredUpdateCandidate(
  input: BuildVerifiedLayeredCandidateInput,
): VerifiedLayeredUpdateCandidate {
  const changes = diffAuthenticatedComponentInventories(
    input.previous,
    input.candidate,
  );
  const base = {
    releaseId: input.releaseId,
    releaseSequence: input.releaseSequence,
    manifestSha256: input.candidate.manifestSha256,
    signingKeyId: input.signingKeyId,
    verifiedAt: input.verifiedAt,
    changes,
  } satisfies Omit<
    VerifiedLayeredUpdateCandidate,
    "policy" | "renderer" | "runtime"
  >;

  return {
    ...base,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.renderer === undefined ? {} : { renderer: input.renderer }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  };
}
