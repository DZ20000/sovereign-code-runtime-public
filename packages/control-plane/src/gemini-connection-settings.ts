import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateHeaderValue } from "node:http";
import { z } from "zod";

const ordinaryText = z.string().min(1).max(2_048).refine((value) => !/[\r\n\0]/u.test(value));
function safeUrl(value: string, kind: "public" | "discovery" | "introspection"): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol !== "https:" &&
        !(kind === "introspection" && url.protocol === "http:" && url.hostname === "127.0.0.1")) return false;
    return kind !== "public" || url.pathname === "/mcp";
  } catch {
    return false;
  }
}

export const geminiConfigurationSchema = z.object({
  publicMcpUrl: ordinaryText.refine((value) => safeUrl(value, "public")),
  oauthDiscoveryUrl: ordinaryText.refine((value) => safeUrl(value, "discovery")),
  introspectionUrl: ordinaryText.refine((value) => safeUrl(value, "introspection")),
  clientId: z.string().min(1).max(256).refine((value) => !/[\r\n\0]/u.test(value)),
  loopbackPort: z.number().int().min(0).max(65_535),
}).strict();

const secretValue = z.string().min(1).max(4_096).refine((value) => value.trim().length > 0 && !/[\r\n\0]/u.test(value));
type SecretPurpose = "ownerSubject" | "introspectionAuthorization";
const secretEnvelopeSchema = z.object({
  schemaVersion: z.literal("scr.gemini-protected-value/v1"),
  purpose: z.enum(["ownerSubject", "introspectionAuthorization"]),
  value: secretValue,
}).strict();

export function encodeGeminiSecret(purpose: SecretPurpose, value: string): string {
  const envelope = JSON.stringify(secretEnvelopeSchema.parse({
    schemaVersion: "scr.gemini-protected-value/v1", purpose, value,
  }));
  if (Buffer.byteLength(envelope, "utf8") > 4_096) throw new Error();
  return envelope;
}

export function decodeGeminiSecret(purpose: SecretPurpose, encoded: string): string {
  const envelope = secretEnvelopeSchema.parse(JSON.parse(encoded));
  if (envelope.purpose !== purpose || Buffer.byteLength(encoded, "utf8") > 4_096) throw new Error();
  return envelope.value;
}

function protectedUpdate(purpose: SecretPurpose) {
  return z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep") }).strict(),
    z.object({ action: z.literal("forget") }).strict(),
    z.object({ action: z.literal("replace"), value: secretValue.refine((value) => {
      try {
        encodeGeminiSecret(purpose, value);
        if (purpose === "introspectionAuthorization") validateHeaderValue("Authorization", value);
        return true;
      } catch { return false; }
    }) }).strict(),
  ]);
}
export const geminiConfigurationInputSchema = geminiConfigurationSchema.extend({
  ownerSubject: protectedUpdate("ownerSubject"),
  introspectionAuthorization: protectedUpdate("introspectionAuthorization"),
}).strict();

const ciphertext = z.string().min(1).max(16_384).nullable();
const settingsSchema = z.object({
  schemaVersion: z.literal("scr.gemini-connection-settings/v1"),
  configuration: geminiConfigurationSchema.nullable(),
  enabled: z.boolean(),
  ownerSubjectEncrypted: ciphertext,
  introspectionAuthorizationEncrypted: ciphertext,
}).strict();

export type GeminiConnectionSettings = z.infer<typeof settingsSchema>;
export const EMPTY_GEMINI_CONNECTION_SETTINGS: GeminiConnectionSettings = {
  schemaVersion: "scr.gemini-connection-settings/v1",
  configuration: null,
  enabled: false,
  ownerSubjectEncrypted: null,
  introspectionAuthorizationEncrypted: null,
};

export const GEMINI_CONNECTION_ERRORS = {
  invalid: "Gemini connection settings are invalid.",
  read: "Gemini connection settings could not be read. Existing settings were preserved.",
  save: "Gemini connection settings could not be saved. Existing settings were preserved.",
  protect: "Windows protected storage could not save the Gemini credentials.",
  restore: "Windows protected storage could not restore the Gemini credentials.",
  owner: "Only the active Runtime Host can change the Gemini connection.",
  configuration: "Save the Gemini connection settings and credentials before starting.",
  gateway: "Start the local Gateway before starting the Gemini connection.",
  discovery: "The OAuth server configuration could not be verified.",
  bridge: "The local Gateway could not prepare the Gemini connection.",
  port: "The Gemini listener port is already in use. The existing service was left running.",
  listen: "The Gemini listener could not start on the selected loopback port.",
  timeout: "Gemini connection startup timed out.",
} as const;

export async function readGeminiConnectionSettings(path: string): Promise<GeminiConnectionSettings> {
  try {
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error();
      const buffer = Buffer.alloc(65_537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 65_536) throw new Error();
      return settingsSchema.parse(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_GEMINI_CONNECTION_SETTINGS };
    }
    throw new Error(GEMINI_CONNECTION_ERRORS.read);
  }
}

export async function writeGeminiConnectionSettings(path: string, settings: GeminiConnectionSettings): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const validated = settingsSchema.parse(settings);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > 65_536) throw new Error();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } catch {
    throw new Error(GEMINI_CONNECTION_ERRORS.save);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
