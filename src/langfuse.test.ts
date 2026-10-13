import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANGFUSE_URL,
  langfuseExport,
  langfuseOptions,
} from "./langfuse.ts";

describe(langfuseOptions, () => {
  it("exports to Langfuse when both keys are set", () => {
    expect(
      langfuseOptions({
        publicKey: "pk",
        secretKey: "sk",
        baseUrl: "https://langfuse.example",
      })
    ).toStrictEqual({
      baseUrl: "https://langfuse.example",
      publicKey: "pk",
      secretKey: "sk",
    });
  });

  it("uses the local Langfuse when no URL is set", () => {
    expect(langfuseOptions({ publicKey: "pk", secretKey: "sk" })?.baseUrl).toBe(
      DEFAULT_LANGFUSE_URL
    );
  });

  it("turns tracing off when neither key is set, blank or missing", () => {
    expect(langfuseOptions({})).toBeUndefined();
    expect(langfuseOptions({ publicKey: "", secretKey: "" })).toBeUndefined();
  });

  it("refuses a public key without its secret key", () => {
    expect(() => langfuseOptions({ publicKey: "pk" })).toThrow(
      /LANGFUSE_SECRET_KEY/u
    );
    expect(() => langfuseOptions({ publicKey: "pk", secretKey: "" })).toThrow(
      /LANGFUSE_SECRET_KEY/u
    );
  });

  it("refuses a secret key without its public key", () => {
    expect(() => langfuseOptions({ secretKey: "sk" })).toThrow(
      /LANGFUSE_PUBLIC_KEY/u
    );
  });
});

describe(langfuseExport, () => {
  it("strips a trailing slash from the base URL", () => {
    expect(
      langfuseExport({
        baseUrl: "http://localhost:3000/",
        publicKey: "pk",
        secretKey: "sk",
      }).url
    ).toBe("http://localhost:3000/api/public/otel/v1/traces");
  });
});
