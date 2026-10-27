import { describe, expect, it } from "vitest";

import { desktopUrl } from "./vnc";

describe(desktopUrl, () => {
  it("goes to the server's relay under the page's loopback name", () => {
    expect(
      desktopUrl({
        apiUrl: "http://127.0.0.1:4000",
        pageOrigin: "http://localhost:3001",
        conversation: 3,
      })
    ).toBe("ws://localhost:4000/api/conversations/3/desktop");
  });

  // Behind a tunnel the browser cannot reach the server's loopback address; the tunnel routes the desktop path.
  it("goes to the page's own origin behind a tunnel", () => {
    expect(
      desktopUrl({
        apiUrl: "http://127.0.0.1:4000",
        pageOrigin: "https://pi.example.com",
        conversation: 3,
      })
    ).toBe("wss://pi.example.com/api/conversations/3/desktop");
  });
});
