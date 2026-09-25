import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyEngine, createPrincipal } from "@sovereign/runtime-core";
import { ToolCatalog } from "@sovereign/toolkit";
import { assertGatewayBearerToken } from "../src/bearer-token.js";
import { createGatewayApplication } from "../src/app.js";
import { startGatewayRuntime } from "../src/runtime.js";

const invalid: unknown[] = [undefined, null, 42, "", "short", " ".repeat(32),
  "replace-with-a-long-random-local-token", "REPLACE_WITH_A_LONG_RANDOM_LOCAL_TOKEN",
  "your-bearer-token-goes-here", "example-bearer-token-do-not-use",
  "placeholder-bearer-token", "changeme-changeme-changeme", "a".repeat(1025),
  "a".repeat(16) + "\n", "contains whitespace in token"];

describe("Gateway bearer configuration", () => {
  it.each(invalid)("rejects unsafe configured value %# without echoing it", value => {
    expect(() => assertGatewayBearerToken(value)).toThrow(/random Gateway bearer token/);
    if (typeof value === "string" && value.length > 15) {
      try { assertGatewayBearerToken(value); } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    }
  });
  it("accepts fresh CSPRNG output without transforming it", () => {
    const value = randomBytes(32).toString("base64url");
    expect(() => assertGatewayBearerToken(value)).not.toThrow();
  });
  it("keeps the checked-in environment example non-operational", async () => {
    const source = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
    const value = source.match(/^SCR_BEARER_TOKEN=(.*)$/mu)?.[1];
    expect(value).toBe("");
    expect(() => assertGatewayBearerToken(value)).toThrow();
  });
  it("rejects the former example before creating runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-bearer-guard-"));
    try {
      await expect(startGatewayRuntime({workspaceRoot:root, port:0,
        bearerToken:"replace-with-a-long-random-local-token", runCompletionNotificationsEnabled:false,
      })).rejects.toMatchObject({code:"AUTH_REQUIRED"});
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, {recursive:true, force:true}); }
  });
  it("also rejects example grants when callers bypass the runtime factory", () => {
    const catalog = new ToolCatalog([], new PolicyEngine(), "0.1.0");
    expect(() => createGatewayApplication({runtimeVersion:"0.1.0", catalog,
      bearerGrants:[{token:"replace-with-a-long-random-local-token",principal:createPrincipal("fixture",[],[])}],
      allowedHosts:["127.0.0.1"],allowedOrigins:["http://127.0.0.1"],
    })).toThrow(/random Gateway bearer token/);
  });
});
