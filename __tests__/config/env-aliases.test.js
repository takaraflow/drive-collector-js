import { describe, expect, test } from "vitest";
import {
  D1_ACCOUNT_ID_ENV_KEYS,
  D1_DATABASE_ID_ENV_KEYS,
  D1_TOKEN_ENV_KEYS,
  OSS_WORKER_SECRET_ENV_KEYS,
  OSS_WORKER_URL_ENV_KEYS,
  firstEnvValue
} from "../../src/config/env-aliases.js";

describe("config env aliases", () => {
  test("should keep canonical D1 variables ahead of legacy aliases", () => {
    expect(D1_ACCOUNT_ID_ENV_KEYS.slice(0, 2)).toEqual([
      "CLOUDFLARE_D1_ACCOUNT_ID",
      "CF_D1_ACCOUNT_ID"
    ]);
    expect(D1_DATABASE_ID_ENV_KEYS).toEqual([
      "CLOUDFLARE_D1_DATABASE_ID",
      "CF_D1_DATABASE_ID"
    ]);
    expect(D1_TOKEN_ENV_KEYS).toEqual([
      "CLOUDFLARE_D1_TOKEN",
      "CF_D1_TOKEN"
    ]);
  });

  test("should keep canonical OSS worker variables ahead of R2 worker aliases", () => {
    expect(OSS_WORKER_URL_ENV_KEYS).toEqual([
      "OSS_WORKER_URL",
      "R2_WORKER_URL"
    ]);
    expect(OSS_WORKER_SECRET_ENV_KEYS).toEqual([
      "OSS_WORKER_SECRET",
      "R2_WORKER_AUTH_TOKEN"
    ]);
  });

  test("should return the first non-empty alias value", () => {
    const env = {
      CANONICAL: " ",
      LEGACY: "legacy-value"
    };

    expect(firstEnvValue(env, ["CANONICAL", "LEGACY"])).toBe("legacy-value");
    expect(firstEnvValue(env, ["MISSING"])).toBeNull();
  });
});
