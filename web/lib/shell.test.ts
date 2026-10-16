import { describe, expect, it } from "vitest";

import { shellClosedReason, shellUrl } from "./shell";

describe(shellUrl, () => {
  it("points at the server's own URL with the ws scheme and the PTY size", () => {
    const url = new URL(
      shellUrl({
        apiUrl: "http://127.0.0.1:4000",
        conversation: 7,
        columns: 120,
        rows: 40,
      })
    );
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/api/conversations/7/shell");
    expect(url.searchParams.get("cols")).toBe("120");
    expect(url.searchParams.get("rows")).toBe("40");
  });

  it("upgrades https to wss", () => {
    const url = new URL(
      shellUrl({
        apiUrl: "https://pi.example.com",
        conversation: 1,
        columns: 80,
        rows: 24,
      })
    );
    expect(url.protocol).toBe("wss:");
  });
});

describe(shellClosedReason, () => {
  it("reads the reason of a closed frame", () => {
    expect(shellClosedReason('{"type":"closed","reason":"sandbox"}')).toBe(
      "sandbox"
    );
    expect(shellClosedReason('{"type":"closed","reason":"exited"}')).toBe(
      "exited"
    );
  });

  it("ignores other frames and non-JSON text", () => {
    expect(
      shellClosedReason('{"type":"resize","columns":10,"rows":5}')
    ).toBeUndefined();
    expect(shellClosedReason("not json")).toBeUndefined();
    expect(shellClosedReason('{"type":"closed"}')).toBeUndefined();
  });

  it("maps a reason it does not know to unavailable", () => {
    expect(shellClosedReason('{"type":"closed","reason":"bogus"}')).toBe(
      "unavailable"
    );
  });
});
