import { z } from "zod";

import type { ToolSpec } from "@sovereign/runtime-core";
import type { ToolExecutionContext } from "./tool-execution-context.js";

export interface RuntimeToolDefinition {
  readonly spec: ToolSpec;
  readonly inputShape: z.ZodRawShape;
  readonly parse: (input: unknown) => Record<string, unknown>;
  readonly workspaceId: (input: Readonly<Record<string, unknown>>) => string | undefined;
  readonly execute: (
    context: ToolExecutionContext,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}

type JsonSchemaProperty = Readonly<Record<string, unknown>>;

export function objectSchema(
  properties: Readonly<Record<string, JsonSchemaProperty>>,
  required: readonly string[] = Object.keys(properties),
): Readonly<Record<string, unknown>> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

export function defineTool<TShape extends z.ZodRawShape>(
  spec: ToolSpec,
  inputShape: TShape,
  execute: (
    context: ToolExecutionContext,
    input: z.output<z.ZodObject<TShape>>,
  ) => Promise<unknown> | unknown,
  workspaceId?: (input: z.output<z.ZodObject<TShape>>) => string | undefined,
): RuntimeToolDefinition {
  const schema = z.object(inputShape).strict();
  return {
    spec,
    inputShape,
    parse(input): Record<string, unknown> {
      return schema.parse(input) as Record<string, unknown>;
    },
    workspaceId(input): string | undefined {
      return workspaceId?.(input as z.output<typeof schema>);
    },
    async execute(context, input): Promise<unknown> {
      return execute(context, input as z.output<typeof schema>);
    },
  };
}
