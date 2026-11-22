import { afterEach, expect, it, vi } from "vitest";
import { createGeminiTokenVerifier } from "../src/gemini-oauth.js";

afterEach(() => vi.unstubAllGlobals());

it("accepts only an active token for the paired user, app and MCP resource", async () => {
  const publicEndpoint = "https://gemini.example.test/mcp";
  const active = { active: true, sub: "owner", client_id: "gemini", aud: [publicEndpoint],
    scope: "sovereign.mcp", exp: Math.floor(Date.now() / 1000) + 60 };
  const claims = new Map([
    ["paired", active], ["wrong-owner", { ...active, sub: "another" }],
    ["wrong-client", { ...active, client_id: "another" }],
    ["wrong-resource", { ...active, aud: ["https://another.example.test/mcp"] }],
    ["revoked", { ...active, active: false }],
  ]);
  const introspectionUrl = "http://127.0.0.1:51133/introspect";
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    expect(url.href).toBe(introspectionUrl);
    expect(init.redirect).toBe("error");
    const submitted = (init.body as URLSearchParams).get("token") ?? "";
    return Promise.resolve(Response.json(claims.get(submitted)));
  });
  const verifier = createGeminiTokenVerifier({ publicEndpoint, introspectionUrl, introspectionAuthorization: "Basic fixture",
    ownerSubject: "owner", clientId: "gemini" });
  await expect(verifier.verifyAccessToken("paired")).resolves.toMatchObject({
    clientId: "gemini", scopes: ["sovereign.mcp"],
  });
  for (const token of ["wrong-owner", "wrong-client", "wrong-resource", "revoked"]) {
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow("not authorized");
  }
});
