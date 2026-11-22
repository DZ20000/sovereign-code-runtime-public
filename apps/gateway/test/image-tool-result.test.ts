import { describe, expect, it } from "vitest";
import { presentScreenshotResult } from "../src/mcp-tool-result.js";

describe("global image tool MCP content", () => {
  const sample = {
    workspaceId: "desktop-workspace",
    relativePath: "fixtures/mcp-image.png",
    bytes: 68,
    sha256: "a".repeat(64),
    mimeType: "image/png",
    imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZqNRAAAAAASUVORK5CYII=",
  };
  it("emits native image blocks and omits base64 from JSON metadata", () => {
    const value = presentScreenshotResult("files.read_image", sample);
    expect(value.images).toHaveLength(1);
    expect(value.images[0]).toMatchObject({ type: "image", mimeType: "image/png", data: sample.imageBase64 });
    expect(value.result).toMatchObject({ relativePath: sample.relativePath, bytes: sample.bytes });
    expect(value.result).not.toHaveProperty("imageBase64");
  });
  it("rejects empty or unsupported image content", () => {
    expect(() => presentScreenshotResult("files.read_image", { ...sample, imageBase64: "" })).toThrow();
    expect(() => presentScreenshotResult("files.read_image", { ...sample, mimeType: "text/html" })).toThrow();
    expect(() => presentScreenshotResult("files.read_image", { ...sample, imageBase64: "not-base64!" })).toThrow();
    expect(() => presentScreenshotResult("files.read_image", { ...sample, imageBase64: Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64") })).toThrow();
  });
  it("keeps text-only tool results unchanged", () => {
    const result = { path: "tests/fixture.png", bytes: 123 };
    expect(presentScreenshotResult("files.metadata", result)).toEqual({ result, images: [] });
  });
});
