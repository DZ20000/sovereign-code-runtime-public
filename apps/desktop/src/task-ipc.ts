import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC_CHANNELS,
  type DesktopTaskDetail,
  type DesktopTaskWorkspaceSnapshot,
  type TaskCoordinationOperatorInbox,
} from "./shared.js";

interface TaskIpcController {
  readonly taskWorkspaceSnapshot: (
    offset?: number,
    limit?: number,
  ) => Promise<DesktopTaskWorkspaceSnapshot>;
  readonly taskDetail: (
    taskId: string,
    messageLimit?: number,
    beforeSequence?: number,
  ) => Promise<DesktopTaskDetail>;
  readonly taskCoordinationInbox: (
    taskId: string,
    beforeSequence?: number,
    limit?: number,
  ) => Promise<TaskCoordinationOperatorInbox>;
  readonly addTaskUserMessage: (
    taskId: string,
    content: string,
  ) => Promise<DesktopTaskDetail>;
}
function taskId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new Error("Task id must contain 1 through 128 characters.");
  return value;
}
function optionalInteger(
  value: unknown,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new Error(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  return Number(value);
}
export function registerTaskIpc(
  controller: TaskIpcController,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
): void {
  ipcMain.handle(
    IPC_CHANNELS.getTaskWorkspace,
    async (event, offset: unknown, limit: unknown) => {
      assertTrustedSender(event);
      return await controller.taskWorkspaceSnapshot(
        optionalInteger(offset, 0, 0, 500, "Task snapshot offset")!,
        optionalInteger(limit, 64, 1, 100, "Task snapshot limit")!,
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.getTaskDetail,
    async (event, id: unknown, limit: unknown, before: unknown) => {
      assertTrustedSender(event);
      return await controller.taskDetail(
        taskId(id),
        typeof limit === "number" && Number.isInteger(limit)
          ? Math.max(1, Math.min(limit, 500))
          : 200,
        optionalInteger(before, undefined, 1, Number.MAX_SAFE_INTEGER, "Conversation cursor"),
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.getTaskCoordinationInbox,
    async (event, id: unknown, before: unknown, limit: unknown) => {
      assertTrustedSender(event);
      return await controller.taskCoordinationInbox(
        taskId(id),
        optionalInteger(
          before,
          undefined,
          1,
          Number.MAX_SAFE_INTEGER,
          "Coordination inbox cursor",
        ),
        optionalInteger(limit, 50, 1, 100, "Coordination inbox limit")!,
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.sendTaskUserMessage,
    async (event, id: unknown, content: unknown) => {
      assertTrustedSender(event);
      if (
        typeof content !== "string" ||
        content.trim().length === 0 ||
        content.length > 8_000
      )
        throw new Error(
          "Task message must contain 1 through 8,000 characters.",
        );
      return await controller.addTaskUserMessage(taskId(id), content);
    },
  );
}
