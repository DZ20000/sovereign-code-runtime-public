import type {
  DesktopTaskProjectSummary,
  DesktopTaskWorkspaceSnapshot,
} from "../shared.js";
import { validateTaskListItemIntegrity } from "./task-list-item-integrity.js";

export type TaskWorkspaceAssemblyResult =
  | { readonly kind: "continue"; readonly nextOffset: number }
  | { readonly kind: "retry" }
  | {
      readonly kind: "complete";
      readonly snapshot: DesktopTaskWorkspaceSnapshot;
    };

function pageTaskCount(page: DesktopTaskWorkspaceSnapshot): number {
  return page.projects.reduce(
    (count, project) => count + project.tasks.length,
    0,
  );
}

function validateProjectWindow(project: DesktopTaskProjectSummary): void {
  for (const [label, value] of [
    ["task count", project.taskCount],
    ["active task count", project.activeTaskCount],
    ["attention task count", project.attentionTaskCount],
    ["online Agent count", project.onlineAgentCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Task workspace pagination project ${project.id} ${label} must be a non-negative safe integer.`,
      );
    }
  }
  if (project.tasks.length > project.taskCount) {
    throw new Error(
      `Task workspace pagination project ${project.id} returned more tasks than its declared total.`,
    );
  }
  if (
    project.activeTaskCount > project.taskCount ||
    project.attentionTaskCount > project.taskCount ||
    project.onlineAgentCount > project.taskCount
  ) {
    throw new Error(
      `Task workspace pagination project ${project.id} summary count exceeds its task total.`,
    );
  }
}
function stableProjectMetadataMatches(
  left: DesktopTaskProjectSummary,
  right: DesktopTaskProjectSummary,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.root === right.root &&
    left.status === right.status &&
    left.taskCount === right.taskCount &&
    left.activeTaskCount === right.activeTaskCount &&
    left.attentionTaskCount === right.attentionTaskCount &&
    left.onlineAgentCount === right.onlineAgentCount &&
    left.updatedAt === right.updatedAt
  );
}

function assertSafePageInteger(
  value: number,
  label: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `Task workspace pagination ${label} must be a safe integer greater than or equal to ${minimum}.`,
    );
  }
}

function validatePageWindow(page: DesktopTaskWorkspaceSnapshot): void {
  if (page.schemaVersion !== "scr.task-workspace/v1") {
    throw new Error("Task workspace pagination schema version is unsupported.");
  }
  if (!Number.isFinite(Date.parse(page.generatedAt))) {
    throw new Error(
      "Task workspace pagination generatedAt must be a valid timestamp.",
    );
  }
  assertSafePageInteger(page.revision, "revision", 0);
  assertSafePageInteger(page.offset, "offset", 0);
  assertSafePageInteger(page.limit, "limit", 1);
  assertSafePageInteger(page.totalTaskCount, "task total", 0);
  assertSafePageInteger(page.totalProjectCount, "project total", 0);
  if (page.nextOffset !== null) {
    assertSafePageInteger(page.nextOffset, "next offset", 0);
  }
}
export class TaskWorkspaceSnapshotAssembler {
  #firstPage: DesktopTaskWorkspaceSnapshot | null = null;
  #expectedOffset = 0;
  #closed = false;
  readonly #projects = new Map<string, DesktopTaskProjectSummary>();
  readonly #taskIds = new Set<string>();

  addPage(page: DesktopTaskWorkspaceSnapshot): TaskWorkspaceAssemblyResult {
    if (this.#closed) {
      throw new Error("Task workspace pagination assembler is already closed.");
    }
    validatePageWindow(page);

    if (this.#firstPage === null) {
      this.#firstPage = page;
    } else if (
      page.schemaVersion !== this.#firstPage.schemaVersion ||
      page.revision !== this.#firstPage.revision ||
      page.totalTaskCount !== this.#firstPage.totalTaskCount ||
      page.totalProjectCount !== this.#firstPage.totalProjectCount
    ) {
      this.#closed = true;
      return { kind: "retry" };
    }

    if (page.offset !== this.#expectedOffset) {
      throw new Error(
        "Task workspace pagination returned an unexpected offset.",
      );
    }

    const returnedTaskCount = pageTaskCount(page);
    if (returnedTaskCount > page.limit) {
      throw new Error(
        "Task workspace pagination returned more items than its declared limit.",
      );
    }
    if (page.offset + returnedTaskCount > page.totalTaskCount) {
      throw new Error(
        "Task workspace pagination returned more tasks than the declared total.",
      );
    }

    const pageProjectIds = new Set<string>();
    for (const project of page.projects) {
      validateProjectWindow(project);
      if (pageProjectIds.has(project.id)) {
        throw new Error(
          `Task workspace pagination duplicated project ${project.id} within one page.`,
        );
      }
      pageProjectIds.add(project.id);
      if (project.tasks.length === 0) {
        throw new Error(
          `Task workspace pagination returned empty project ${project.id}.`,
        );
      }

      const existing = this.#projects.get(project.id);
      if (
        existing !== undefined &&
        !stableProjectMetadataMatches(existing, project)
      ) {
        throw new Error(
          `Task workspace pagination changed project ${project.id} within one revision.`,
        );
      }

      const tasks = existing === undefined ? [] : [...existing.tasks];
      for (const task of project.tasks) {
        validateTaskListItemIntegrity(task);
        if (this.#taskIds.has(task.id)) {
          throw new Error(
            `Task workspace pagination duplicated task ${task.id}.`,
          );
        }
        this.#taskIds.add(task.id);
        tasks.push(task);
      }
      this.#projects.set(project.id, { ...project, tasks });
    }

    const expectedNextOffset = page.offset + returnedTaskCount;
    if (page.nextOffset === null) {
      if (
        expectedNextOffset !== page.totalTaskCount ||
        this.#taskIds.size !== page.totalTaskCount
      ) {
        throw new Error(
          "Task workspace pagination ended before every declared task was loaded.",
        );
      }
      if (this.#projects.size !== page.totalProjectCount) {
        throw new Error(
          "Task workspace pagination project count did not match the declared total.",
        );
      }
      for (const project of this.#projects.values()) {
        if (project.tasks.length !== project.taskCount) {
          throw new Error(
            `Task workspace pagination project ${project.id} task count did not match its declared total.`,
          );
        }
      }

      const base = this.#firstPage;
      if (base === null) {
        throw new Error(
          "Task workspace pagination did not receive a first page.",
        );
      }
      this.#closed = true;
      return {
        kind: "complete",
        snapshot: {
          ...base,
          offset: 0,
          limit: Math.max(1, base.totalTaskCount),
          nextOffset: null,
          projects: [...this.#projects.values()],
        },
      };
    }

    if (
      returnedTaskCount === 0 ||
      page.nextOffset !== expectedNextOffset ||
      page.nextOffset > page.totalTaskCount
    ) {
      throw new Error("Task workspace pagination did not advance safely.");
    }
    this.#expectedOffset = page.nextOffset;
    return { kind: "continue", nextOffset: page.nextOffset };
  }
}
