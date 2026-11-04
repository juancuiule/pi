import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  checkSoftware,
  dockerfile,
  normalize,
  offered,
  SOFTWARE,
} from "./software.ts";

const SHELL = ["node", "python-data", "imagemagick", "ffmpeg"];

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
      [SHELL, SHELL],
    ]);
  });

  it("orders a selection as the catalog does, each entry once", () => {
    expect(
      normalize(["ffmpeg", "node", "ffmpeg", "imagemagick"])
    ).toStrictEqual(["node", "imagemagick", "ffmpeg"]);
  });

  it("drops a retired entry, which a base image has now, wherever it was recorded", () => {
    // Chrome is in every image for agent-browser: a Workspace that recorded it still loads, builds no layer for it,
    // and passes the checks even at the shell Level it once needed the desktop for.
    expect([
      offered("desktop", "x64").includes("chrome"),
      normalize(["chrome", "node"]),
      checkSoftware("shell", ["chrome"], "x64"),
      dockerfile("effect-pi/sandbox-desktop", ["chrome"]),
    ]).toStrictEqual([
      false,
      ["node"],
      undefined,
      "FROM effect-pi/sandbox-desktop\n",
    ]);
  });

  it("retires uv, which every image has now with pip", () => {
    expect([
      offered("shell").includes("uv"),
      normalize(["uv", "node"]),
    ]).toStrictEqual([false, ["node"]]);
  });

  it("names, for each command an offered entry provides, the entry that adds it", () => {
    // docker/sandbox/sandbox-env.sh maps a missing command to its Software; this keeps the two in step.
    const handler = readFileSync(
      new URL("../../docker/sandbox/sandbox-env.sh", import.meta.url),
      "utf-8"
    );
    const named = new Map<string, string>();
    for (const { groups } of handler.matchAll(
      /^\s*(?<commands>[\w |-]+)\) software="(?<id>[\w-]+):/gmu
    )) {
      for (const command of groups?.commands?.split("|") ?? []) {
        named.set(command.trim(), groups?.id ?? "");
      }
    }
    const provided = new Map(
      offered("desktop").flatMap((id) =>
        SOFTWARE[id].commands.map((command) => [command, id] as const)
      )
    );
    expect(named).toStrictEqual(provided);
  });

  it("says why a Level cannot have a selection", () => {
    expect([
      checkSoftware("none", []),
      checkSoftware("shell", ["node", "ffmpeg"], "x64"),
      checkSoftware("none", ["node"], "x64"),
    ]).toStrictEqual([
      undefined,
      undefined,
      "Software needs a shell or desktop",
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
