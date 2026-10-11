import { describe, expect, it } from "vitest";

import { vncViewUrl } from "./vnc";

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
