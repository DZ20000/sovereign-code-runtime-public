import type { ReleaseManifest } from "./manifest.js";
﻿import {
  planComponentUpdate,
  type ComponentUpdatePlan,
  type ComponentUpdatePolicy,
  type UpdateComponentChange,
} from "./update-plan.js";

export const RELEASE_SNAPSHOT_SCHEMA_VERSION =
  "scr.release-snapshot/v1" as const;

const RELEASE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_COMPONENTS = 20_000;
const MAX_COMPONENT_BYTES = 4 * 1_024 * 1_024 * 1_024;

export interface ReleaseComponentSnapshot {
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ReleaseSnapshot {
  readonly schemaVersion: typeof RELEASE_SNAPSHOT_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly components: readonly ReleaseComponentSnapshot[];
}

export interface ReleaseComponentDiff {
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly currentReleaseSequence: number;
  readonly candidateReleaseSequence: number;
  readonly changes: readonly UpdateComponentChange[];
}

export interface PlannedReleaseTransition extends ReleaseComponentDiff {
  readonly plan: ComponentUpdatePlan;
}

interface IndexedComponent {
  readonly component: ReleaseComponentSnapshot;
  readonly portablePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value).sort();
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function assertBoundedText(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid or exceeds its length limit.`);
  }
}

function normalizeComponentPath(value: unknown, label: string): string {
  assertBoundedText(value, label, 1_024);
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`${label} must be a portable relative path.`);
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

function parseStrictVersion(value: unknown, label: string): string {
  assertBoundedText(value, label, 64);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${label} must use canonical major.minor.patch form.`);
  }
  return value;
}

function parseComponent(
  value: unknown,
  index: number,
): ReleaseComponentSnapshot {
  if (!isRecord(value)) {
    throw new Error(`Release component ${index} must be an object.`);
  }
  assertExactKeys(
    value,
    ["path", "role", "sha256", "bytes"],
    `Release component ${index}`,
  );
  const path = normalizeComponentPath(
    value.path,
    `Release component ${index} path`,
  );
  assertBoundedText(value.role, `Release component ${path} role`, 128);
  const role = value.role.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(role)) {
    throw new Error(`Release component ${path} role is invalid.`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`Release component ${path} SHA-256 is invalid.`);
  }
  if (
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > MAX_COMPONENT_BYTES
  ) {
    throw new Error(`Release component ${path} byte length is invalid.`);
  }
  return { path, role, sha256: value.sha256, bytes: value.bytes as number };
}

export function parseReleaseSnapshot(value: unknown): ReleaseSnapshot {
  if (!isRecord(value)) {
    throw new Error("Release snapshot must be an object.");
  }
  assertExactKeys(
    value,
    ["schemaVersion", "releaseId", "releaseSequence", "version", "components"],
    "Release snapshot",
  );
  if (value.schemaVersion !== RELEASE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Unsupported release snapshot schema version.");
  }
  assertBoundedText(value.releaseId, "Release ID", 256);
  if (!RELEASE_ID_PATTERN.test(value.releaseId)) {
    throw new Error("Release ID is invalid.");
  }
  if (
    !Number.isSafeInteger(value.releaseSequence) ||
    (value.releaseSequence as number) < 1
  ) {
    throw new Error("Release sequence must be a positive safe integer.");
  }
  const version = parseStrictVersion(value.version, "Release version");
  if (
    !Array.isArray(value.components) ||
    value.components.length > MAX_COMPONENTS
  ) {
    throw new Error(`Release snapshot exceeds ${MAX_COMPONENTS} components.`);
  }
  const components = value.components
    .map(parseComponent)
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const portablePaths = new Set<string>();
  for (const component of components) {
    const key = component.path.toLowerCase();
    if (portablePaths.has(key)) {
      throw new Error(
        `Release snapshot contains a duplicate portable path: ${component.path}.`,
      );
    }
    portablePaths.add(key);
  }
  return {
    schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence as number,
    version,
    components,
  };
}

function indexComponents(
  components: readonly ReleaseComponentSnapshot[],
): ReadonlyMap<string, IndexedComponent> {
  return new Map(
    components.map((component) => [
      component.path.toLowerCase(),
      { component, portablePath: component.path.toLowerCase() },
    ]),
  );
}

function change(
  component: ReleaseComponentSnapshot,
  kind: UpdateComponentChange["change"],
): UpdateComponentChange {
  return { path: component.path, role: component.role, change: kind };
}

/**
 * Computes a conservative component diff. A role transition is represented as
 * removal of the old role and addition of the new role, preventing a candidate
 * from downgrading the update strategy by relabeling a native component as a
 * renderer asset.
 */
export function diffReleaseSnapshots(
  currentValue: ReleaseSnapshot,
  candidateValue: ReleaseSnapshot,
): ReleaseComponentDiff {
  const current = parseReleaseSnapshot(currentValue);
  const candidate = parseReleaseSnapshot(candidateValue);
  if (current.releaseId === candidate.releaseId) {
    throw new Error(
      "Candidate release ID must differ from the active release ID.",
    );
  }
  if (candidate.releaseSequence <= current.releaseSequence) {
    throw new Error(
      "Candidate release sequence must be newer than the active release.",
    );
  }

  const currentByPath = indexComponents(current.components);
  const candidateByPath = indexComponents(candidate.components);
  const paths = [
    ...new Set([...currentByPath.keys(), ...candidateByPath.keys()]),
  ].sort();
  const changes: UpdateComponentChange[] = [];

  for (const path of paths) {
    const before = currentByPath.get(path)?.component;
    const after = candidateByPath.get(path)?.component;
    if (before === undefined && after !== undefined) {
      changes.push(change(after, "added"));
      continue;
    }
    if (before !== undefined && after === undefined) {
      changes.push(change(before, "removed"));
      continue;
    }
    if (before === undefined || after === undefined) continue;

    if (before.path !== after.path) {
      changes.push(change(before, "removed"), change(after, "added"));
      continue;
    }
    if (before.role !== after.role) {
      changes.push(change(before, "removed"), change(after, "added"));
      continue;
    }
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
      changes.push(change(after, "modified"));
    }
  }

  return {
    currentReleaseId: current.releaseId,
    candidateReleaseId: candidate.releaseId,
    currentReleaseSequence: current.releaseSequence,
    candidateReleaseSequence: candidate.releaseSequence,
    changes,
  };
}

export function planReleaseTransition(
  current: ReleaseSnapshot,
  candidate: ReleaseSnapshot,
  policy: ComponentUpdatePolicy = {},
): PlannedReleaseTransition {
  const diff = diffReleaseSnapshots(current, candidate);
  return { ...diff, plan: planComponentUpdate(diff.changes, policy) };
}


export interface VerifiedReleaseUpdatePlan {
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly changes: readonly UpdateComponentChange[];
  readonly plan: ComponentUpdatePlan;
}

interface ComparableVerifiedComponent {
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
  readonly bytes: number;
}

function verifiedComponentMap(
  manifest: ReleaseManifest,
  label: string,
): ReadonlyMap<string, ComparableVerifiedComponent> {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof manifest.releaseId !== "string" ||
    !Array.isArray(manifest.components)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  const components = new Map<string, ComparableVerifiedComponent>();
  for (const component of manifest.components) {
    if (
      typeof component !== "object" ||
      component === null ||
      typeof component.path !== "string" ||
      typeof component.role !== "string" ||
      typeof component.sha256 !== "string" ||
      !Number.isSafeInteger(component.bytes)
    ) {
      throw new Error(`${label} contains an invalid component.`);
    }
    const key = component.path.toLowerCase();
    if (components.has(key)) {
      throw new Error(`${label} contains a case-insensitive component collision.`);
    }
    components.set(key, {
      path: component.path,
      role: component.role,
      sha256: component.sha256,
      bytes: component.bytes,
    });
  }
  return components;
}

function verifiedRoleTransition(
  previousRole: string,
  candidateRole: string,
): string {
  return `role-transition:${previousRole}->${candidateRole}`.slice(0, 128);
}

/**
 * Computes a component diff from manifests that were already authenticated by
 * the signed release verifier. Role changes fail closed as an unknown role.
 */
export function diffVerifiedReleaseComponents(
  current: ReleaseManifest,
  candidate: ReleaseManifest,
): readonly UpdateComponentChange[] {
  if (current.releaseId === candidate.releaseId) {
    throw new Error("Candidate release ID must differ from the active release ID.");
  }
  const previous = verifiedComponentMap(current, "Current release manifest");
  const next = verifiedComponentMap(candidate, "Candidate release manifest");
  const keys = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const changes: UpdateComponentChange[] = [];
  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if (before === undefined && after !== undefined) {
      changes.push({ path: after.path, role: after.role, change: "added" });
      continue;
    }
    if (before !== undefined && after === undefined) {
      changes.push({ path: before.path, role: before.role, change: "removed" });
      continue;
    }
    if (before === undefined || after === undefined) continue;
    if (before.path !== after.path || before.role !== after.role) {
      changes.push({
        path: after.path,
        role: verifiedRoleTransition(before.role, after.role),
        change: "modified",
      });
      continue;
    }
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
      changes.push({ path: after.path, role: after.role, change: "modified" });
    }
  }
  return changes;
}

export function planVerifiedReleaseUpdate(
  current: ReleaseManifest,
  candidate: ReleaseManifest,
  policy: ComponentUpdatePolicy = {},
): VerifiedReleaseUpdatePlan {
  const changes = diffVerifiedReleaseComponents(current, candidate);
  return {
    currentReleaseId: current.releaseId,
    candidateReleaseId: candidate.releaseId,
    changes,
    plan: planComponentUpdate(changes, policy),
  };
}
