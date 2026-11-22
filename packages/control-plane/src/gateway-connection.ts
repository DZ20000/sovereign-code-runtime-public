import { serializeConnectionBundle, type SovereignConnectionBundle } from "@sovereign/control-plane-contract";

export interface ControlPlaneConnectionBundle {
  readonly endpoint: string;
  readonly target: "local" | "web-bridge";
  readonly serialized: string;
}

export function normalizeGatewayBearerToken(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(normalized)) {
    throw new Error("Gateway bearer token must be canonical 256-bit base64url.");
  }
  return normalized;
}

export function localGatewayConnection(endpoint: string | null, bearerToken: string | null): SovereignConnectionBundle | null {
  return endpoint === null || bearerToken === null
    ? null
    : JSON.parse(serializeConnectionBundle(endpoint, bearerToken)) as SovereignConnectionBundle;
}

export function desktopConnectionBundle(
  endpoint: string | null,
  bearerToken: string | null,
  webBridgeUrl: string | null,
): ControlPlaneConnectionBundle {
  if (endpoint === null || bearerToken === null) {
    throw new Error("Start the local Gateway before copying its connection bundle.");
  }
  return {
    endpoint: webBridgeUrl ?? endpoint,
    target: webBridgeUrl === null ? "local" : "web-bridge",
    serialized: serializeConnectionBundle(webBridgeUrl ?? endpoint, bearerToken),
  };
}
