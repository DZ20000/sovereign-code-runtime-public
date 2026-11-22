# Reading workspace images

`files.read_image` is a built-in Sovereign tool for PNG, JPEG and WebP files up to **6 MiB**. It is available through the standard MCP gateway. The optional Gemini bridge exposes the same operation as `files_read_image`.

## Input and output

Provide an authorized `workspaceId` and a workspace-relative `path`, for example:

```json
{
  "workspaceId": "workspace",
  "path": "fixtures/sample.png"
}
```

A successful MCP call returns a short JSON metadata text block and a separate `type: "image"` content block. Metadata contains the normalized relative path, byte count, SHA-256 and MIME type. The pixels appear only in the image block; they are removed from `structuredContent` and the metadata text. The Gemini projection forwards that image block unchanged.

## Permission and file boundaries

The operation requires `files.read` and the selected workspace's existing permission policy. Its catalog declares `permissionLevel: workspace` and `approvalMode: single-use`. Reading an image discloses its pixels to the connected client and potentially that client's model provider.

Sovereign verifies the opened file handle against the authorized workspace and rejects multiple hard links and changed file identities. The reader checks the filename extension against PNG/JPEG/WebP signatures and reads at most 6 MiB plus one byte, so growth after the size check cannot cause an unbounded read. The existing path guard continues to reject absolute, traversal, network and symbolic-link escapes. The image file is not modified.

## Client behavior and verification

Use a client that renders MCP image content, and refresh its tool catalog after installing the release. A successful metadata-only response is insufficient to establish image delivery.

The automated tests send a synthetic PNG through a real isolated Streamable HTTP gateway, then through the Gemini projection, and compare the returned pixels. They also cover authorization, traversal, hard links, mismatched signatures and size limits. These protocol tests do not claim that a live model has recognized an image.

For an end-to-end check, create a synthetic image with a private test value, keep the value out of the filename and prompt, and ask the connected client to read that image. Use a disposable workspace rather than personal photos.

See [Gemini connection setup](gemini-connection.md) for the optional OAuth-protected bridge.
