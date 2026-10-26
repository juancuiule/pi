import { describe, expect, it } from "vitest";

import { isLoopbackRequest, viaHttpsPublicUrl } from "./loopback.ts";

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
    const ports = { pagePorts: [3001, 4000] };
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

  const publicUrl = new URL("https://pi.example.com");

  it("accepts the public URL's host and origin, through the proxy or straight", () => {
    const options = { pagePorts: [3001, 4000], publicUrl };
    // Next's rewrite: the server's own Host, the tunnel's host forwarded.
    expect(
      isLoopbackRequest(
        {
          host: "127.0.0.1:4000",
          origin: "https://pi.example.com",
          "x-forwarded-host": "pi.example.com",
        },
        options
      )
    ).toBeTruthy();
    // The shell's socket, routed by the tunnel straight to the server.
    expect(
      isLoopbackRequest(
        { host: "pi.example.com", origin: "https://pi.example.com" },
        options
      )
    ).toBeTruthy();
    // Loopback pages keep working beside it.
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", origin: "http://localhost:3001" },
        options
      )
    ).toBeTruthy();
  });

  it("rejects anything near the public URL that is not it", () => {
    const options = { publicUrl };
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", origin: "http://pi.example.com" },
        options
      )
    ).toBeFalsy();
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", origin: "https://evil.pi.example.com" },
        options
      )
    ).toBeFalsy();
    expect(
      isLoopbackRequest({ host: "pi.example.com:8443" }, options)
    ).toBeFalsy();
    expect(
      isLoopbackRequest(
        { host: "127.0.0.1:4000", "x-forwarded-host": "pi.example.com.evil" },
        options
      )
    ).toBeFalsy();
    // Without a public URL its host is just a foreign one.
    expect(isLoopbackRequest({ host: "pi.example.com" })).toBeFalsy();
  });
});

describe(viaHttpsPublicUrl, () => {
  const publicUrl = new URL("https://pi.example.com");

  it("is true only for a request that came through an https public URL", () => {
    expect(
      viaHttpsPublicUrl(
        { host: "127.0.0.1:4000", "x-forwarded-host": "pi.example.com" },
        publicUrl
      )
    ).toBeTruthy();
    expect(
      viaHttpsPublicUrl({ host: "pi.example.com" }, publicUrl)
    ).toBeTruthy();
    expect(
      viaHttpsPublicUrl(
        { host: "127.0.0.1:4000", "x-forwarded-host": "localhost:3001" },
        publicUrl
      )
    ).toBeFalsy();
    expect(
      viaHttpsPublicUrl(
        { host: "pi.example.com" },
        new URL("http://pi.example.com")
      )
    ).toBeFalsy();
    expect(viaHttpsPublicUrl({ host: "pi.example.com" })).toBeFalsy();
  });
});
