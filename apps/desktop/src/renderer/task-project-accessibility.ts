export interface TaskProjectAccessibilityIds {
  readonly titleId: string;
  readonly rootId: string;
  readonly metricsId: string;
  readonly tasksId: string;
}

function projectIdHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function projectIdStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return stem.length > 0 ? stem : "project";
}

export function taskProjectAccessibilityIds(
  projectId: string,
): TaskProjectAccessibilityIds {
  const base = `task-project-${projectIdStem(projectId)}-${projectIdHash(projectId)}`;
  return {
    titleId: `${base}-title`,
    rootId: `${base}-root`,
    metricsId: `${base}-metrics`,
    tasksId: `${base}-tasks`,
  };
}
