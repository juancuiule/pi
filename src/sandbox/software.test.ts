import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
      [[...SHELL, "agent-browser"], SHELL],
      [[...SHELL, "chrome", "agent-browser"], SHELL],
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

  it("installs agent-browser behind a wrapper with this platform's defaults", () => {
    const { install } = SOFTWARE["agent-browser"];
    // The step that writes the wrapper, run here with its output kept instead of written to /usr/local/bin.
    const step = install.slice(
      install.indexOf("printf "),
      install.indexOf(" > /usr/local/bin/agent-browser")
    );
    const wrapper = execFileSync("sh", ["-c", step], {
      encoding: "utf-8",
    });
    const root = mkdtempSync(path.join(tmpdir(), "agent-browser-wrapper-"));
    try {
      const profile = path.join(root, "profile");
      execFileSync("mkdir", ["-p", profile]);
      writeFileSync(path.join(profile, "SingletonLock"), "");
      // `env` in place of the binary prints what agent-browser would run with.
      const script = path.join(root, "agent-browser");
      writeFileSync(
        script,
        wrapper.replace(
          'exec /opt/agent-browser/agent-browser "$@"',
          "exec env"
        )
      );
      const env = execFileSync("sh", [script], {
        encoding: "utf-8",
        env: { PATH: process.env.PATH, AGENT_BROWSER_PROFILE: profile },
      });
      expect(install).toContain("sha256sum -c -");
      expect(
        env
          .split("\n")
          .filter((line) => line.startsWith("AGENT_BROWSER_"))
          .toSorted()
      ).toStrictEqual([
        "AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage",
        "AGENT_BROWSER_CONTENT_BOUNDARIES=1",
        "AGENT_BROWSER_MAX_OUTPUT=40000",
        `AGENT_BROWSER_PROFILE=${profile}`,
        "AGENT_BROWSER_SESSION=workspace",
      ]);
      // No Chrome runs here, so a lock left by an earlier Sandbox goes.
      expect(existsSync(path.join(profile, "SingletonLock"))).toBeFalsy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
