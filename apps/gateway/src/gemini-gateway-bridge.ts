import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import express, { type Request } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { parseGeminiLocalConnection } from "./gemini-local-connection.js";

const connectionScope = "sovereign.mcp";
const manifestSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
});
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(), params: z.record(z.string(), z.unknown()).optional(),
});
const methods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
interface GeminiGatewayOptions {
  readonly publicEndpoint: string;
  readonly authorizationServer: OAuthMetadata;
  readonly verifyToken: OAuthTokenVerifier;
  readonly localConnection: unknown;
  readonly reloadLocalConnection?: () => Promise<unknown>;
  readonly startupSignal?: AbortSignal;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function exactAlias(name: string) {
  return name.replace(/[.-]/gu, "_");
}

export async function createGeminiGatewayBridge(options: GeminiGatewayOptions) {
  const localConnection = parseGeminiLocalConnection(options.localConnection);
  let local = new URL(localConnection.transport.url);
  const resource = new URL(options.publicEndpoint);
  if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" ||
      local.pathname !== "/mcp" || !local.port || local.username || local.password || local.hash || local.search ||
      resource.protocol !== "https:" || resource.pathname !== "/mcp" ||
      resource.username || resource.password || resource.hash || resource.search) {
    throw new Error("Gemini requires an HTTPS MCP URL and the local Sovereign 127.0.0.1 MCP connection bundle.");
  }
  let authorization = localConnection.transport.headers.Authorization;
  let generation = 0;
  // Startup has a deadline; this separate signal lasts until this bridge is disposed.
  const lifetime = new AbortController();
  const lookupTools = async (signal?: AbortSignal) => {
    const active = AbortSignal.any([lifetime.signal, ...(signal === undefined ? [] : [signal])]);
    active.throwIfAborted();
    const probe = () => fetch(new URL("/v1/manifest", local), {
      headers: { Authorization: authorization }, redirect: "error",
      signal: AbortSignal.any([active, AbortSignal.timeout(5000)]),
    });
    let reply = await probe().catch((error) => {
      active.throwIfAborted();
      if (!options.reloadLocalConnection) throw error;
      return undefined;
    });
    active.throwIfAborted();
    if (!reply?.ok && options.reloadLocalConnection) {
      const current = parseGeminiLocalConnection(await options.reloadLocalConnection());
      active.throwIfAborted();
      if (current.transport.url !== local.href || current.transport.headers.Authorization !== authorization) {
        local = new URL(current.transport.url); authorization = current.transport.headers.Authorization; generation++;
      }
      reply = await probe();
    }
    active.throwIfAborted();
    if (!reply?.ok) throw new Error("The Sovereign connection bundle is stale or the local gateway is unavailable.");
    const tools = manifestSchema.parse(await reply.json()).tools;
    active.throwIfAborted();
    const names = new Map(tools.map((tool) => [exactAlias(tool.name), tool]));
    if (names.size !== tools.length) {
      throw new Error("The Sovereign catalog contains an ambiguous Gemini tool name.");
    }
    return names;
  };
  await lookupTools(options.startupSignal);

  // Authenticate the externally visible session reference. A GPT session ID
  // alone cannot be reused through this connection.
  const binding = randomBytes(32);
  type UpstreamSession = { id: string; generation: number; initialize: Record<string, unknown> };
  const sessions = new Map<string, UpstreamSession>();
  const mac = (id: string, clientId: string) =>
    createHmac("sha256", binding).update(JSON.stringify([clientId, id])).digest("base64url");
  const unbind = (value: string, clientId: string) => {
    const fields = /^([a-f0-9-]{36})\.([\w-]{43})$/u.exec(value);
    if (!fields?.[1] || !fields[2]) return null;
    return timingSafeEqual(Buffer.from(mac(fields[1], clientId)), Buffer.from(fields[2])) ? fields[1] : null;
  };

  const app = express();
  app.disable("x-powered-by");
  const requestSignals = new WeakMap<Request, AbortSignal>();
  app.use((req, res, next) => {
    const closed = new AbortController();
    const abort = () => closed.abort();
    req.once("aborted", abort);
    res.once("close", () => {
      abort();
      req.off("aborted", abort);
    });
    const signal = AbortSignal.any([lifetime.signal, closed.signal]);
    requestSignals.set(req, signal);
    if (signal.aborted) res.sendStatus(503);
    else next();
  });
  app.use(mcpAuthMetadataRouter({
    oauthMetadata: options.authorizationServer, resourceServerUrl: resource, resourceName: "Sovereign",
    scopesSupported: [connectionScope],
  }));
  app.all(resource.pathname, requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        const auth = await options.verifyToken.verifyAccessToken(token);
        if (auth.resource?.href !== resource.href) {
          throw new InvalidTokenError("The token is not authorized for this MCP resource.");
        }
        return auth;
      },
    },
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource), requiredScopes: [connectionScope],
  }), express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }), async (req, res) => {
    const clientId = req.auth?.clientId;
    if (!clientId) { res.sendStatus(401); return; }
    if (!["GET", "POST", "DELETE"].includes(req.method)) { res.sendStatus(405); return; }
    const session = req.get("mcp-session-id");
    const boundSession = session === undefined ? undefined : unbind(session, clientId);
    if (boundSession === null || (boundSession !== undefined && !sessions.has(boundSession))) { res.sendStatus(404); return; }
    let message: z.infer<typeof requestSchema> | undefined;
    const errorResult = (code: number, messageText: string) => {
      res.status(200).json({ jsonrpc: "2.0", id: message?.id ?? null, error: { code, message: messageText } });
    };
    res.setHeader("Cache-Control", "no-store");
    try {
      const upstreamSignal = requestSignals.get(req)!;
      upstreamSignal.throwIfAborted();
      const catalog = await lookupTools(upstreamSignal);
      upstreamSignal.throwIfAborted();
      const target = new URL(local);
      const targetAuthorization = authorization;
      const targetGeneration = generation;
      if (req.method === "POST") {
        const decoded = requestSchema.safeParse(req.body);
        if (!decoded.success) { res.sendStatus(400); return; }
        message = decoded.data;
        if (message.method === "initialize" && boundSession === undefined && sessions.size >= 256) {
          res.status(429).json({ error: "The Gemini bridge session capacity has been reached." }); return;
        }
        if (!methods.has(message.method)) { errorResult(-32601, "This MCP method is not available."); return; }
        if (message.params) {
          // The downstream caller cannot bind transport affinity to a ChatGPT identity.
          const { _meta, ...params } = message.params;
          message = { ...message, params };
        }
        if (message.method === "tools/call") {
          const params = message.params;
          const name = params?.name;
          const original = params?.arguments === undefined ? {} : asObject(params.arguments);
          if (typeof name !== "string" || original === undefined) { errorResult(-32602, "Invalid tool call."); return; }
          const tool = catalog.get(name);
          if (!tool) { errorResult(-32602, "This tool is not in the current Sovereign catalog."); return; }
          message = { ...message, params: { name: tool.name, arguments: original } };
        }
      }
      const headers: Record<string, string> = {
        Authorization: targetAuthorization,
        Accept: req.method === "GET" ? "text/event-stream" : "application/json, text/event-stream",
      };
      for (const key of ["mcp-protocol-version", "last-event-id"]) {
        const value = req.get(key);
        if (value !== undefined) headers[key] = value;
      }
      const state = boundSession === undefined ? undefined : sessions.get(boundSession);
      let upstreamSession = state?.id;
      if (state && state.generation !== targetGeneration) {
          const initial = await fetch(target, { method: "POST", redirect: "error", signal: upstreamSignal,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "gemini-reconnect", method: "initialize", params: state.initialize }) });
          upstreamSignal.throwIfAborted();
          const id = initial.headers.get("mcp-session-id");
          if (!initial.ok || !id || !/^[a-f0-9-]{36}$/u.test(id)) throw new Error("The new local MCP session did not initialize.");
          const initialWire = asObject(await initial.json());
          upstreamSignal.throwIfAborted();
          if (!initialWire?.result || initialWire.error) throw new Error("The new local MCP initialization failed.");
          const initialized = await fetch(target, { method: "POST", redirect: "error", signal: upstreamSignal,
            headers: { ...headers, "Content-Type": "application/json", "Mcp-Session-Id": id },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
          if (!initialized.ok) throw new Error("The new local MCP session was not ready.");
          await initialized.arrayBuffer();
          upstreamSignal.throwIfAborted();
          state.id = id; state.generation = targetGeneration; upstreamSession = id;
      }
      if (upstreamSession) headers["Mcp-Session-Id"] = upstreamSession;
      if (message) headers["Content-Type"] = "application/json";
      upstreamSignal.throwIfAborted();
      const upstream = await fetch(target, {
        method: req.method, headers, redirect: "error", signal: upstreamSignal,
        ...(message ? { body: JSON.stringify(message) } : {}),
      });
      upstreamSignal.throwIfAborted();
      if (upstream.status === 401) { res.status(502).json({ error: "The local Sovereign connection expired." }); return; }
      const newSession = upstream.headers.get("mcp-session-id");
      if (newSession && /^[a-f0-9-]{36}$/u.test(newSession)) {
        const front = boundSession ?? newSession;
        sessions.set(front, { id: newSession, generation: targetGeneration, initialize: state?.initialize ?? message?.params ?? {} });
        res.setHeader("Mcp-Session-Id", front + "." + mac(front, clientId));
      }
      if (req.method === "DELETE" && upstream.ok && boundSession) sessions.delete(boundSession);
      const contentType = upstream.headers.get("content-type");
      if (contentType?.includes("application/json") && (message?.method === "tools/list" || message?.method === "tools/call")) {
        const wire = asObject(await upstream.json());
        upstreamSignal.throwIfAborted();
        const result = asObject(wire?.result);
        if (result && message.method === "tools/list" && Array.isArray(result.tools)) {
          const tools: Array<Record<string, unknown> & { name: string }> = result.tools.map((entry: Record<string, unknown>) => {
            const { outputSchema, ...tool } = entry;
            return { ...tool, name: exactAlias(String(tool.name)) };
          });
          result.tools = tools;
        }
        if (result && message.method === "tools/call") {
          delete result.structuredContent;
        }
        res.status(upstream.status).json(wire);
        return;
      }
      if (contentType) res.setHeader("Content-Type", contentType);
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
      res.status(upstream.status);
      if (!upstream.body) res.end();
      else await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
    } catch (error) {
      if (error instanceof z.ZodError && !res.headersSent && !res.destroyed) {
        errorResult(-32602, error.message);
        return;
      }
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: "The local Sovereign gateway did not return a confirmed result." });
    }
  });
  return Object.assign(app, {
    dispose() {
      lifetime.abort();
      sessions.clear();
    },
  });
}
