import { RuntimeError } from "@sovereign/runtime-core";

/** Configuration guard, not an entropy estimator. Generate secrets with a CSPRNG. */
export function assertGatewayBearerToken(
  value: unknown,
  code: "AUTH_REQUIRED" | "INTERNAL_ERROR" = "AUTH_REQUIRED",
): asserts value is string {
  if (
    typeof value !== "string" || value.length < 16 || value.length > 1024 ||
    /\s/u.test(value) ||
    /^(?:replace[-_]?with|change[-_]?me|your[-_].*token|example[-_].*token|placeholder)/iu.test(value)
  ) {
    // Never include the supplied value in errors, logs, or audit records.
    throw new RuntimeError(
      code,
      "Configure a random Gateway bearer token (16-1024 non-whitespace characters); empty and example values are not accepted. See docs/development.md.",
      500,
    );
  }
}
