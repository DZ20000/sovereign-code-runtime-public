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
  if (toolName === "files.read_image") {
    if (result === null || typeof result !== "object" || Array.isArray(result)
        || !("imageBase64" in result)) {
      throw new RuntimeError("INTERNAL_ERROR", "Image tool did not return image content.", 500);
    }
    const { imageBase64, ...metadata } = result;
    const mimeType = "mimeType" in metadata ? metadata.mimeType : undefined;
    const maxImageBytes = 6 * 1024 * 1024;
    if (typeof imageBase64 !== "string" || imageBase64.length === 0
        || imageBase64.length > 4 * Math.ceil(maxImageBytes / 3)
        || !["image/png", "image/jpeg", "image/webp"].includes(String(mimeType))) {
      throw new RuntimeError("INTERNAL_ERROR", "Image payload is invalid or oversized.", 500);
    }
    const bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length === 0 || bytes.length > maxImageBytes || bytes.toString("base64") !== imageBase64) {
      throw new RuntimeError("INTERNAL_ERROR", "Image payload is not valid bounded Base64.", 500);
    }
    const image = ImageContentSchema.safeParse({ type: "image", mimeType, data: imageBase64 });
    if (!image.success) {
      throw new RuntimeError("INTERNAL_ERROR", "Image payload did not pass the MCP image contract.", 500);
    }
    return { result: metadata, images: [image.data] };
  }
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
