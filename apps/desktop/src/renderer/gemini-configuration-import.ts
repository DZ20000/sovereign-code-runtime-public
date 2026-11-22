export interface GeminiPublicConfiguration {
  readonly publicMcpUrl: string;
  readonly oauthDiscoveryUrl: string;
  readonly introspectionUrl: string;
  readonly clientId: string;
  readonly loopbackPort: number;
}
const fields = ["publicMcpUrl", "oauthDiscoveryUrl", "introspectionUrl", "clientId", "loopbackPort"] as const;
export function parseGeminiConfiguration(text: string): GeminiPublicConfiguration {
  if (text.length > 65_536) throw new Error("Configuration is too large.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Enter a JSON configuration object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter a JSON configuration object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !(fields as readonly string[]).includes(key))) throw new Error("Import only the five public configuration fields.");
  for (const key of fields.slice(0, 3)) {
    if (typeof record[key] !== "string" || (record[key] as string).length > 4096) throw new Error("Use a valid HTTPS address for each URL.");
    let url: URL;
    try { url = new URL(record[key] as string); } catch { throw new Error("Use a valid HTTPS address for each URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Use HTTPS addresses without credentials or fragments.");
  }
  if (typeof record.clientId !== "string" || !record.clientId.trim() || record.clientId.length > 256) throw new Error("Enter a client ID of at most 256 characters.");
  if (!Number.isInteger(record.loopbackPort) || Number(record.loopbackPort) < 0 || Number(record.loopbackPort) > 65535) throw new Error("Use a port between 0 and 65535.");
  return { publicMcpUrl: String(record.publicMcpUrl), oauthDiscoveryUrl: String(record.oauthDiscoveryUrl), introspectionUrl: String(record.introspectionUrl), clientId: record.clientId.trim(), loopbackPort: Number(record.loopbackPort) };
}
export const EXAMPLE_GEMINI_CONFIGURATION: GeminiPublicConfiguration = {
  publicMcpUrl: "https://mcp.example.com/gemini", oauthDiscoveryUrl: "https://auth.example.com/discovery",
  introspectionUrl: "https://auth.example.com/introspect", clientId: "desktop-client", loopbackPort: 0,
};
