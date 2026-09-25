import {
  ImageContentSchema,
  type ImageContent,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { RuntimeError } from "@sovereign/runtime-core";

const TOOL_RESULT_SCHEMA_VERSION = "scr.mcp-tool-result/v2";
// The native desktop capture already caps JPEGs at eight million bytes.
const MAX_SCREENSHOT_BYTES = 8_000_000;
const MAX_SCREENSHOT_BASE64_LENGTH = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3);

export const TOOL_RESULT_OUTPUT_SCHEMA: NonNullable<Tool["outputSchema"]> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    schemaVersion: { const: TOOL_RESULT_SCHEMA_VERSION },
    result: {},
    operatorInbox: {},
  },
  required: ["schemaVersion", "result"],
};

export function serializeResult(value: unknown): string {
  const serialized = JSON.stringify(
    value,
    (_key, child: unknown) =>
      typeof child === "bigint" ? child.toString() : child,
    2,
  );
  return serialized ?? "null";
}

export function structuredToolResult(
  result: unknown,
  operatorInbox?: unknown,
): Record<string, unknown> {
  return {
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    result: JSON.parse(serializeResult(result)) as unknown,
    ...(operatorInbox === undefined
      ? {}
      : {
          operatorInbox: JSON.parse(serializeResult(operatorInbox)) as unknown,
        }),
  };
}

export function presentScreenshotResult(
  toolName: string,
  result: unknown,
): { readonly result: unknown; readonly images: readonly ImageContent[] } {
  if (
    (toolName !== "browser.observe" && toolName !== "computer.observe") ||
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("screenshotBase64" in result) ||
    result.screenshotBase64 === undefined
  ) {
    return { result, images: [] };
  }

  const { screenshotBase64, ...metadata } = result;
  if (
    typeof screenshotBase64 !== "string" ||
    screenshotBase64.length === 0 ||
    screenshotBase64.length > MAX_SCREENSHOT_BASE64_LENGTH ||
    !("screenshotMediaType" in metadata) ||
    metadata.screenshotMediaType !== "image/jpeg"
  ) {
    throw new RuntimeError("INTERNAL_ERROR", "The observation returned an invalid or oversized JPEG screenshot.", 500);
  }
  const image = ImageContentSchema.safeParse({
    type: "image",
    mimeType: "image/jpeg",
    data: screenshotBase64,
  });
  if (
    !image.success ||
    Buffer.byteLength(screenshotBase64, "base64") > MAX_SCREENSHOT_BYTES
  ) {
    throw new RuntimeError("INTERNAL_ERROR", "The observation returned an invalid or oversized JPEG screenshot.", 500);
  }
  return { result: metadata, images: [image.data] };
}
