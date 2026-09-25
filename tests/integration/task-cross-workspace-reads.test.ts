import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CAPABILITIES, PolicyEngine, createPrincipal } from "../../packages/runtime-core/src/index.js";
import { ToolCatalog } from "../../packages/toolkit/src/index.js";
import { createTaskTools } from "../../packages/control-plane/src/task-tools.js";
import { fixture } from "./task-registry-fixture.js";

it("reads owned tasks across sibling workspaces without granting task writes or other-principal reads", async () => {
  const { root, workspace, registry } = await fixture();
  const otherRoot = join(root, "home-design-lab");
  await mkdir(otherRoot);
  const owned = registry.createTask({ title: "Home design", agentId: "owner" }, "chatgpt-web", otherRoot);
  const hidden = registry.createTask({ title: "Private task", agentId: "other" }, "other-principal", otherRoot);
  registry.addUserMessage(owned.id, "Continue the design.");
  registry.addUserMessage(hidden.id, "Private message.");
  const catalog = new ToolCatalog(createTaskTools(registry, workspace, "desktop-workspace"), new PolicyEngine(), "test");
  const context = { principal: createPrincipal("chatgpt-web", CAPABILITIES, ["desktop-workspace"]), sessionId: "read-session" };
  const invoke = (name: string, input: Record<string, unknown>) => catalog.invoke(name, context, input);

  expect(await invoke("tasks.get", { taskId: owned.id, messageLimit: 3 })).toMatchObject({ task: { id: owned.id } });
  expect(JSON.stringify(await invoke("tasks.messages.list", { taskId: owned.id, afterSequence: 1, limit: 1 }))).toContain("Continue the design.");
  for (const name of ["tasks.list", "tasks.inbox"]) {
    const result = JSON.stringify(await invoke(name, {}));
    expect(result).toContain(owned.id);
    expect(result).not.toContain(hidden.id);
  }
  for (const name of ["tasks.get", "tasks.messages.list"]) {
    await expect(invoke(name, { taskId: hidden.id })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  }
  await expect(invoke("tasks.update", { taskId: owned.id, agentId: "owner", summary: "Must not change" }))
    .rejects.toMatchObject({ code: "PATH_ESCAPE" });
  expect(registry.requiredTask(owned.id).summary).not.toBe("Must not change");
});
