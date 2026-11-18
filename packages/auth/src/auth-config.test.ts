import { describe, expect, test } from "bun:test";
import { API_KEY_RATE_LIMIT, createQuantSelfAuth } from "./auth-config";

describe("auth configuration", () => {
  test("allows high-volume API clients without disabling rate limiting", () => {
    expect(API_KEY_RATE_LIMIT).toEqual({
      enabled: true,
      maxRequests: 25_000,
      timeWindow: 24 * 60 * 60 * 1000,
    });
  });

  test("uses the configured instance name", () => {
    expect(createQuantSelfAuth("Quantself Prod 1.0").options.appName).toBe("Quantself Prod 1.0");
  });
});
