import { describe, expect, it } from "vitest";

import { isLoopbackRequest } from "./loopback.ts";

describe(isLoopbackRequest, () => {
  it("accepts loopback hosts with or without a loopback origin", () => {
    expect(isLoopbackRequest({ host: "127.0.0.1:4000" })).toBeTruthy();
    expect(
      isLoopbackRequest({
        host: "127.0.0.1:4000",
        origin: "http://localhost:3001",
        "x-forwarded-host": "localhost:3001",
      })
    ).toBeTruthy();
  });

  it("rejects a foreign origin, a rebound host and a foreign forwarded host", () => {
    expect(
      isLoopbackRequest({
        host: "127.0.0.1:4000",
        origin: "https://evil.example",
      })
    ).toBeFalsy();
    expect(isLoopbackRequest({ host: "evil.example:4000" })).toBeFalsy();
    expect(
      isLoopbackRequest({
        host: "127.0.0.1:4000",
        "x-forwarded-host": "evil.example:3001",
      })
    ).toBeFalsy();
    expect(isLoopbackRequest({})).toBeFalsy();
  });

  it("accepts a page only on the given ports once they are set", () => {
    const ports = [3001, 4000];
    expect(
      isLoopbackRequest(
        {
          host: "127.0.0.1:4000",
          origin: "http://localhost:3001",
          "x-forwarded-host": "localhost:3001",
        },
        ports
      )
    ).toBeTruthy();
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", origin: "http://localhost:5173" },
        ports
      )
    ).toBeFalsy();
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", origin: "http://localhost" },
        ports
      )
    ).toBeFalsy();
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", "x-forwarded-host": "localhost:5173" },
        ports
      )
    ).toBeFalsy();
    // Tools send no Origin and pass on Host alone.
    expect(isLoopbackRequest({ host: "127.0.0.1:4000" }, ports)).toBeTruthy();
  });
});
