import { describe, expect, it } from "vitest";
import { EXAMPLE_GEMINI_CONFIGURATION, parseGeminiConfiguration } from "../src/renderer/gemini-configuration-import.js";

describe("Gemini public configuration import", () => {
  it("imports exactly the five public fields with both port boundaries", () => {
    for (const loopbackPort of [0, 65_535]) {
      const value = { ...EXAMPLE_GEMINI_CONFIGURATION, clientId: " client-fixture ", loopbackPort };
      expect(parseGeminiConfiguration(JSON.stringify(value))).toEqual({ ...value, clientId: "client-fixture" });
    }
  });

  it("rejects malformed objects, extra fields and secrets without echoing input", () => {
    const privateFixture = "never-echo-this-fixture";
    const values = ["[]", "null", '"text"', "{", JSON.stringify({ ...EXAMPLE_GEMINI_CONFIGURATION, ownerSubject: privateFixture }),
      JSON.stringify({ ...EXAMPLE_GEMINI_CONFIGURATION, introspectionAuthorization: privateFixture }),
      JSON.stringify({ ...EXAMPLE_GEMINI_CONFIGURATION, unexpected: privateFixture })];
    for (const text of values) {
      expect(() => parseGeminiConfiguration(text)).toThrow();
      try { parseGeminiConfiguration(text); } catch (error) { expect(String(error)).not.toContain(privateFixture); }
    }
    expect(() => parseGeminiConfiguration(" ".repeat(65_537))).toThrow("Configuration is too large.");
  });

  it.each(["publicMcpUrl", "oauthDiscoveryUrl", "introspectionUrl"] as const)("rejects unsafe or oversized %s", key => {
    for (const value of ["http://example.com", "javascript:alert(1)", "https://user:password@example.com", "https://example.com/#fragment", "not a URL", "https://example.com/" + "a".repeat(4096)]) {
      expect(() => parseGeminiConfiguration(JSON.stringify({ ...EXAMPLE_GEMINI_CONFIGURATION, [key]: value }))).toThrow();
    }
  });

  it("requires bounded client identity and an integer port", () => {
    for (const clientId of ["", " ", "a".repeat(257), 42]) {
      expect(() => parseGeminiConfiguration(JSON.stringify({ ...EXAMPLE_GEMINI_CONFIGURATION, clientId }))).toThrow("client ID");
    }
    for (const loopbackPort of [-1, 65_536, 1.5, "0", null]) {
      expect(() => parseGeminiConfiguration(JSON.stringify({ ...EXAMPLE_GEMINI_CONFIGURATION, loopbackPort }))).toThrow("port");
    }
  });
});
