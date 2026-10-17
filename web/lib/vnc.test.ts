import { describe, expect, it } from "vitest";

import { desktopFrameUrl, vncViewUrl } from "./vnc";

const CONSOLE_ORIGIN = "http://localhost:3001";

describe(desktopFrameUrl, () => {
  // frame-src 'self' confines artifact pages; the desktop frame can only load same-origin documents.
  it("resolves on the console's own origin", () => {
    const src = desktopFrameUrl(3, false);
    expect(new URL(src, CONSOLE_ORIGIN).origin).toBe(CONSOLE_ORIGIN);
    expect(src).toBe("/desktop-frame?conversation=3&control=0");
    expect(desktopFrameUrl(3, true)).toBe(
      "/desktop-frame?conversation=3&control=1"
    );
  });
});

describe(vncViewUrl, () => {
  const base = "http://127.0.0.1:55001/vnc.html?autoconnect=true&resize=scale";

  it("is view-only unless the user takes control", () => {
    expect(new URL(vncViewUrl(base, false)).searchParams.get("view_only")).toBe(
      "true"
    );
    expect(new URL(vncViewUrl(base, true)).searchParams.get("view_only")).toBe(
      "false"
    );
  });

  it("keeps the sandbox's own parameters", () => {
    const url = new URL(vncViewUrl(base, false));
    expect(url.searchParams.get("autoconnect")).toBe("true");
    expect(url.searchParams.get("resize")).toBe("scale");
  });
});
