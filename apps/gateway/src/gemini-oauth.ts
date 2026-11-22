import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthMetadataSchema, type OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
const introspectedToken = z.object({
  active: z.literal(true),
  sub: z.string(),
  client_id: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  scope: z.string(),
  exp: z.number().int(),
});

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("An HTTPS URL without embedded credentials, query, or fragment is required.");
  }
  return url;
}

export async function loadGeminiAuthorizationServer(discoveryUrl: string, signal?: AbortSignal): Promise<OAuthMetadata> {
  const endpoint = httpsUrl(discoveryUrl);
  const requestSignal = signal === undefined ? AbortSignal.timeout(5000) : AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const response = await fetch(endpoint, { redirect: "error", signal: requestSignal });
  if (!response.ok) throw new Error("OAuth server discovery failed.");
  const metadata = OAuthMetadataSchema.parse(await response.json());
  httpsUrl(metadata.issuer);
  httpsUrl(metadata.authorization_endpoint);
  httpsUrl(metadata.token_endpoint);
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("The Gemini OAuth server must support PKCE S256.");
  }
  return metadata;
}

interface GeminiIntrospectionOptions {
  readonly introspectionUrl: string;
  readonly introspectionAuthorization: string;
  readonly publicEndpoint: string;
  readonly clientId: string;
  readonly ownerSubject: string;
}

export function createGeminiTokenVerifier(options: GeminiIntrospectionOptions): OAuthTokenVerifier {
  const candidate = new URL(options.introspectionUrl);
  // The authorization server can share this machine without publishing introspection.
  const loopback = candidate.protocol === "http:" && candidate.hostname === "127.0.0.1" &&
    !candidate.username && !candidate.password && !candidate.search && !candidate.hash;
  const endpoint = loopback ? candidate : httpsUrl(options.introspectionUrl);
  const resource = httpsUrl(options.publicEndpoint);
  const { introspectionAuthorization, clientId, ownerSubject } = options;
  return {
    async verifyAccessToken(token) {
      let payload: unknown;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: introspectionAuthorization },
          body: new URLSearchParams({ token, token_type_hint: "access_token" }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error();
        payload = await response.json();
      } catch {
        throw new ServerError("The authorization server could not verify the token.");
      }
      const result = introspectedToken.safeParse(payload);
      if (!result.success || result.data.exp <= Date.now() / 1000 || result.data.sub !== ownerSubject || result.data.client_id !== clientId ||
        ![result.data.aud].flat().includes(resource.href)) {
        throw new InvalidTokenError("The token is inactive or not authorized for Sovereign.");
      }
      return {
        token, clientId, resource, scopes: result.data.scope.split(/\s+/u), expiresAt: result.data.exp,
      };
    },
  };
}
