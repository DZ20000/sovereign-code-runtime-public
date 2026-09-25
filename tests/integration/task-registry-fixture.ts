import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";

const cleanup: string[] = [];

const openRegistries: TaskRegistry[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const registry of openRegistries.splice(0)) {
    try {
      registry.close();
    } catch {
      // Tests normally close explicitly; this is failure-path cleanup.
    }
  }
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      }),
    ),
  );
});

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-task-registry-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const databasePath = join(root, "tasks.sqlite");
  const changes: number[] = [];
  const registry = new TaskRegistry({
    databasePath,
    onChanged: () => changes.push(Date.now()),
  });
  openRegistries.push(registry);
  return { root, workspace, databasePath, changes, registry };
}
