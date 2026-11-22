#!/usr/bin/env node
import { createServer } from "node:http";
import { createGeminiGatewayBridge } from "../apps/gateway/dist/gemini-gateway-bridge.js";
import { readRegisteredGeminiConnection, registerGeminiLocalConnection } from "../apps/gateway/dist/gemini-local-connection.js";
import { createGeminiTokenVerifier, loadGeminiAuthorizationServer } from "../apps/gateway/dist/gemini-oauth.js";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing local setting ${name}`);
  return value;
}
const publicEndpoint = required("SCR_GEMINI_MCP_URL");
const authorizationServer = await loadGeminiAuthorizationServer(required("SCR_GEMINI_OAUTH_DISCOVERY_URL"));
const verifyToken = createGeminiTokenVerifier({
  publicEndpoint,
  introspectionUrl: required("SCR_GEMINI_OAUTH_INTROSPECTION_URL"),
  introspectionAuthorization: required("SCR_GEMINI_OAUTH_INTROSPECTION_AUTHORIZATION"),
  clientId: required("SCR_GEMINI_OAUTH_CLIENT_ID"),
  ownerSubject: required("SCR_GEMINI_OAUTH_OWNER_SUB"),
});
const provided = process.env.SCR_GEMINI_LOCAL_CONNECTION_BUNDLE;
const localConnection = provided
  ? await registerGeminiLocalConnection(JSON.parse(provided))
  : await readRegisteredGeminiConnection();
if (!localConnection) throw new Error("Pair an authorized local Sovereign MCP connection before starting the bridge.");
const app = await createGeminiGatewayBridge({
  publicEndpoint, authorizationServer, verifyToken, localConnection,
  reloadLocalConnection: readRegisteredGeminiConnection,
});
const port = Number(process.env.SCR_GEMINI_LOOPBACK_PORT ?? "0");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid loopback port.");
const server = createServer(app);
server.listen(port, "127.0.0.1", () => {
  console.log(`Sovereign Gemini MCP listening on 127.0.0.1:${server.address().port}`);
});
