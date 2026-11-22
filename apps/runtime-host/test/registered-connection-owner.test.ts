import { describe, expect, it, vi } from "vitest";
import { refreshRegisteredGeminiConnection } from "@sovereign/gateway/runtime";
import {
  REGISTERED_CONNECTION_OWNER_ENV,
  consumeRegisteredConnectionOwnerOptions,
} from "../src/registered-connection-owner.js";

vi.mock("@sovereign/gateway/runtime", () => ({
  refreshRegisteredGeminiConnection: vi.fn(async () => true),
}));

describe("Runtime Host registered-connection owner eligibility", () => {
  it("does not enable user-pairing writes without an explicit product opt-in", () => {
    expect(consumeRegisteredConnectionOwnerOptions({})).toEqual({});
    expect(consumeRegisteredConnectionOwnerOptions({ SystemRoot: "fixture-system" })).toEqual({});
    expect(refreshRegisteredGeminiConnection).not.toHaveBeenCalled();
  });

  it.each(["", "0", "true", " 1", "1 ", "1\n"])("rejects noncanonical opt-in %j", (value) => {
    expect(consumeRegisteredConnectionOwnerOptions({ [REGISTERED_CONNECTION_OWNER_ENV]: value })).toEqual({});
  });

  it.each([
    "SCR_USER_DATA_PATH",
    "SCR_SMOKE_REPORT_PATH",
    "SCR_APPROVAL_SMOKE_REPORT_PATH",
    "SCR_HOST_GUARDIAN_INTEGRATION_DIR",
    "SCR_RESOURCE_BENCHMARK_SCENARIO",
    "SCR_RESOURCE_BENCHMARK_USER_DATA",
    "SCR_RESOURCE_BENCHMARK_OUTPUT",
    "SCR_UPDATE_PREFLIGHT",
    "SCR_UPDATE_PREFLIGHT_RELEASE_ID",
    "SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE",
    "SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256",
  ])("disables publication when the isolated context key %s is present", (key) => {
    for (const name of [key, key.toLowerCase()]) {
      expect(consumeRegisteredConnectionOwnerOptions({
        [REGISTERED_CONNECTION_OWNER_ENV]: "1",
        [name]: "",
      })).toEqual({});
    }
    expect(refreshRegisteredGeminiConnection).not.toHaveBeenCalled();
  });

  it("handles Windows environment casing and ignores undefined, absent isolation values", () => {
    expect(consumeRegisteredConnectionOwnerOptions({
      [REGISTERED_CONNECTION_OWNER_ENV.toLowerCase()]: "1",
      SCR_USER_DATA_PATH: undefined,
    }).onAuthoritativeGatewayConnection).toBeTypeOf("function");
    expect(consumeRegisteredConnectionOwnerOptions({
      [REGISTERED_CONNECTION_OWNER_ENV]: "1",
      [REGISTERED_CONNECTION_OWNER_ENV.toLowerCase()]: "0",
    })).toEqual({});
    expect(refreshRegisteredGeminiConnection).not.toHaveBeenCalled();
  });

  it("consumes every casing of the one-hop opt-in even when the launch is rejected", () => {
    const eligible = { [REGISTERED_CONNECTION_OWNER_ENV]: "1", SystemRoot: "fixture-system" };
    expect(consumeRegisteredConnectionOwnerOptions(eligible).onAuthoritativeGatewayConnection).toBeTypeOf("function");
    expect(eligible).toEqual({ SystemRoot: "fixture-system" });
    expect(consumeRegisteredConnectionOwnerOptions(eligible)).toEqual({});

    const isolated = {
      [REGISTERED_CONNECTION_OWNER_ENV]: "1",
      [REGISTERED_CONNECTION_OWNER_ENV.toLowerCase()]: "0",
      SCR_SMOKE_REPORT_PATH: "fixture-report",
    };
    expect(consumeRegisteredConnectionOwnerOptions(isolated)).toEqual({});
    expect(isolated).toEqual({ SCR_SMOKE_REPORT_PATH: "fixture-report" });
    expect(refreshRegisteredGeminiConnection).not.toHaveBeenCalled();
  });

  it("passes an eight-second cancellation signal and the selected environment to the publisher", async () => {
    const environment = { [REGISTERED_CONNECTION_OWNER_ENV]: "1" };
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const options = consumeRegisteredConnectionOwnerOptions(environment);
    expect(refreshRegisteredGeminiConnection).not.toHaveBeenCalled();
    await options.onAuthoritativeGatewayConnection!("http://127.0.0.1:42000/mcp", "fixture-token");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(8_000);
    expect(environment).not.toHaveProperty(REGISTERED_CONNECTION_OWNER_ENV);
    expect(refreshRegisteredGeminiConnection).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:42000/mcp", "fixture-token", environment, signal,
    );
  });
});
