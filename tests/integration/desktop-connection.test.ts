import { describe, expect, it } from "vitest";

import {
  CONNECTION_BUNDLE_SCHEMA,
  serializeConnectionBundle,
} from "../../apps/desktop/src/shared.js";

describe("desktop connection bundles", () => {
  it("serializes a versioned loopback Streamable HTTP bundle", () => {
    const source = serializeConnectionBundle(
      "http://127.0.0.1:3210/mcp",
      "a-high-entropy-bearer-token-for-tests",
    );
    const bundle = JSON.parse(source) as {
      schemaVersion: string;
      name: string;
      transport: {
        type: string;
        url: string;
        headers: { Authorization: string };
      };
    };

    expect(source.endsWith("\n")).toBe(true);
    expect(bundle.schemaVersion).toBe(CONNECTION_BUNDLE_SCHEMA);
    expect(bundle.name).toBe("sovereign-code-runtime");
    expect(bundle.transport.type).toBe("streamable-http");
    expect(bundle.transport.url).toBe("http://127.0.0.1:3210/mcp");
    expect(bundle.transport.headers.Authorization).toBe(
      "Bearer a-high-entropy-bearer-token-for-tests",
    );
  });

  it("serializes a remote HTTPS bridge bundle for ChatGPT Web", () => {
    const source = serializeConnectionBundle(
      "https://runtime.example.test/mcp",
      "a-high-entropy-bearer-token-for-tests",
    );
    const bundle = JSON.parse(source) as {
      transport: { url: string; headers: { Authorization: string } };
    };

    expect(bundle.transport.url).toBe("https://runtime.example.test/mcp");
    expect(bundle.transport.headers.Authorization).toContain("Bearer ");
  });

  it("rejects insecure remote endpoints and malformed MCP paths", () => {
    expect(() =>
      serializeConnectionBundle(
        "http://runtime.example.test/mcp",
        "a-high-entropy-bearer-token-for-tests",
      ),
    ).toThrow(/https/i);
    expect(() =>
      serializeConnectionBundle(
        "https://runtime.example.test/",
        "a-high-entropy-bearer-token-for-tests",
      ),
    ).toThrow(/\/mcp/i);
  });

  it("rejects endpoint credentials, queries, and fragments", () => {
    expect(() =>
      serializeConnectionBundle(
        "http://owner@127.0.0.1:3210/mcp",
        "a-high-entropy-bearer-token-for-tests",
      ),
    ).toThrow(/credentials/i);
    expect(() =>
      serializeConnectionBundle(
        "https://runtime.example.test/mcp?unsafe=true",
        "a-high-entropy-bearer-token-for-tests",
      ),
    ).toThrow(/query/i);
  });

  it("rejects weak bearer tokens", () => {
    expect(() => serializeConnectionBundle("http://localhost:3210/mcp", "too-short")).toThrow(
      /at least 16/i,
    );
  });
});
