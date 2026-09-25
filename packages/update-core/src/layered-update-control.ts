import type { CutoverRecoveryExecutionReceipt } from "./cutover-recovery-executor.js";
import type {
  LayeredUpdateController,
  LayeredUpdateRecoveryBatchReceipt,
} from "./layered-update-controller.js";
import {
  publicLayeredUpdateStatus,
  type PublicLayeredUpdateStatus,
} from "./layered-update-public.js";
import type { LayeredUpdateStatus } from "./layered-update-status.js";

export const LAYERED_UPDATE_CONTROL_METHODS = [
  "update.layered.status",
  "update.layered.recovery.run",
  "update.layered.recovery.run_all_safe",
] as const;

export type LayeredUpdateControlMethod =
  (typeof LAYERED_UPDATE_CONTROL_METHODS)[number];

export type LayeredUpdateControlResult =
  | PublicLayeredUpdateStatus
  | CutoverRecoveryExecutionReceipt
  | {
      readonly attempted: number;
      readonly completed: readonly CutoverRecoveryExecutionReceipt[];
      readonly finalStatus: PublicLayeredUpdateStatus;
    };

export interface LayeredUpdateControlPort {
  status(): Promise<LayeredUpdateStatus>;
  recover(cutoverId: string): Promise<CutoverRecoveryExecutionReceipt>;
  recoverAllSafe(): Promise<LayeredUpdateRecoveryBatchReceipt>;
}

export interface LayeredUpdateControlServiceOptions {
  readonly controller: LayeredUpdateControlPort | LayeredUpdateController;
}

const METHOD_SET = new Set<string>(LAYERED_UPDATE_CONTROL_METHODS);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactParams(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${label} contains unsupported fields.`);
  }
  return value;
}

function cutoverId(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error("Layered update recovery cutover ID is invalid.");
  }
  return value;
}

export function isLayeredUpdateControlMethod(
  value: unknown,
): value is LayeredUpdateControlMethod {
  return typeof value === "string" && METHOD_SET.has(value);
}

export class LayeredUpdateControlService {
  readonly #controller: LayeredUpdateControlPort;

  constructor(options: LayeredUpdateControlServiceOptions) {
    if (
      typeof options.controller !== "object" ||
      options.controller === null ||
      typeof options.controller.status !== "function" ||
      typeof options.controller.recover !== "function" ||
      typeof options.controller.recoverAllSafe !== "function"
    ) {
      throw new Error("Layered update controller is required.");
    }
    this.#controller = options.controller;
  }

  async handle(
    method: LayeredUpdateControlMethod,
    params: unknown,
  ): Promise<LayeredUpdateControlResult> {
    if (!isLayeredUpdateControlMethod(method)) {
      throw new Error(
        `Unknown layered update control method: ${String(method)}.`,
      );
    }
    switch (method) {
      case "update.layered.status": {
        exactParams(params, [], "Layered update status parameters");
        return publicLayeredUpdateStatus(await this.#controller.status());
      }
      case "update.layered.recovery.run": {
        const record = exactParams(
          params,
          ["cutoverId"],
          "Layered update recovery parameters",
        );
        return await this.#controller.recover(cutoverId(record.cutoverId));
      }
      case "update.layered.recovery.run_all_safe": {
        exactParams(params, [], "Layered update recovery-all parameters");
        const result = await this.#controller.recoverAllSafe();
        return {
          attempted: result.attempted,
          completed: [...result.completed],
          finalStatus: publicLayeredUpdateStatus(result.finalStatus),
        };
      }
    }
  }
}
