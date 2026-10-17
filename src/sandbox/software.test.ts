import { describe, expect, it } from "vitest";

import {
  checkSoftware,
  dockerfile,
  normalize,
  offered,
  SOFTWARE,
} from "./software.ts";

const SHELL = ["node", "uv", "python-data", "imagemagick", "ffmpeg"];

describe("Software", () => {
  it("is offered from its Level up, and only on hosts it installs on", () => {
    expect(
      (["none", "shell", "desktop"] as const).map((level) => [
        offered(level, "x64"),
        offered(level, "arm64"),
      ])
    ).toStrictEqual([
      [[], []],
      [SHELL, SHELL],
      [[...SHELL, "chrome"], SHELL],
    ]);
  });

  it("orders a selection as the catalog does, each entry once", () => {
    expect(normalize(["chrome", "node", "chrome", "uv"])).toStrictEqual([
      "node",
      "uv",
      "chrome",
    ]);
  });

  it("says why a Level cannot have a selection", () => {
    expect([
      checkSoftware("none", []),
      checkSoftware("shell", ["node", "ffmpeg"], "x64"),
      checkSoftware("desktop", ["chrome"], "x64"),
      checkSoftware("none", ["node"], "x64"),
      checkSoftware("shell", ["node", "chrome"], "x64"),
      checkSoftware("desktop", ["chrome"], "arm64"),
    ]).toStrictEqual([
      undefined,
      undefined,
      undefined,
      "Software needs a shell or desktop",
      "Google Chrome needs the desktop Level",
      "Google Chrome is not available on arm64 hosts",
    ]);
  });

  it("builds one layer per entry over the base, in catalog order", () => {
    expect(dockerfile("effect-pi/sandbox-shell", ["ffmpeg", "node"])).toBe(
      [
        "FROM effect-pi/sandbox-shell",
        `RUN ${SOFTWARE.node.install}`,
        `RUN ${SOFTWARE.ffmpeg.install}`,
        "",
      ].join("\n")
    );
  });
});
