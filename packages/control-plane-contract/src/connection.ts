export const CONNECTION_BUNDLE_SCHEMA = "scr.connection/v1" as const;

export interface SovereignConnectionBundle {
  readonly schemaVersion: typeof CONNECTION_BUNDLE_SCHEMA;
  readonly name: "sovereign-code-runtime";
  readonly transport: {
    readonly type: "streamable-http";
    readonly url: string;
    readonly headers: {
      readonly Authorization: string;
    };
  };
}

export interface DesktopConnectionCopyResult {
  readonly schemaVersion: typeof CONNECTION_BUNDLE_SCHEMA;
  readonly endpoint: string;
  readonly target: "local" | "web-bridge";
  readonly copiedAt: string;
  readonly clipboardClearsAt: string;
}

function assertConnectionEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const hostname = url.hostname.toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const loopbackHttp = url.protocol === "http:" && loopbackHosts.has(hostname);
  const remoteHttps = url.protocol === "https:" && !loopbackHosts.has(hostname);
  if (!loopbackHttp && !remoteHttps) {
    throw new Error("Connection bundles require loopback HTTP or a remote HTTPS MCP bridge endpoint.");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Connection bundle endpoints may not contain credentials, query strings, or fragments.");
  }
  if (!url.pathname.endsWith("/mcp")) {
    throw new Error("Connection bundle endpoint path must end with /mcp.");
  }
  return url;
}

export function serializeConnectionBundle(endpoint: string, bearerToken: string): string {
  const url = assertConnectionEndpoint(endpoint);
  if (bearerToken.length < 16) {
    throw new Error("Connection bundle bearer tokens must contain at least 16 characters.");
  }

  const bundle: SovereignConnectionBundle = {
    schemaVersion: CONNECTION_BUNDLE_SCHEMA,
    name: "sovereign-code-runtime",
    transport: {
      type: "streamable-http",
      url: url.toString(),
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  };
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
