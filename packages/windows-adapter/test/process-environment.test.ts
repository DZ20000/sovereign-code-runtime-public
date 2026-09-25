import { describe, expect, it } from "vitest";

import { sanitizedChildEnvironment } from "../src/process-environment.js";

describe("child environment sanitization", () => {
  it("removes inherited Runtime Host credentials and preserves ordinary values", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "fixture",
      SCR_WORKSPACE_ROOT: "C:\workspace",
      SCR_RUNTIME_GATEWAY_BEARER_TOKEN: "secret",
      SCR_CONTROL_SESSION_SECRET: "secret",
      SCR_RUNTIME_PROMOTION_FENCING_TOKEN: "secret",
      CONTROL_PLANE_API_KEY: "secret",
      USER_FLAG: "ok",
    };
    expect(sanitizedChildEnvironment(source)).toEqual({
      PATH: "fixture",
      SCR_WORKSPACE_ROOT: "C:\workspace",
      USER_FLAG: "ok",
    });
  });
});
