import { describe, expect, it } from "vitest";

import {
  leaveConsole,
  loginPath,
  onLeaveConsole,
  safeNext,
  signedIn,
} from "./session";

describe(safeNext, () => {
  it("keeps a path on this origin, with its query and fragment", () => {
    expect([
      safeNext("/settings"),
      safeNext("/?c=12"),
      safeNext("/skills#top"),
    ]).toStrictEqual(["/settings", "/?c=12", "/skills#top"]);
  });

  it("sends anything that could leave the origin home", () => {
    expect([
      safeNext(null),
      safeNext(""),
      safeNext("settings"),
      safeNext("https://evil.example/"),
      safeNext("//evil.example/"),
      safeNext(String.raw`/\evil.example/`),
      safeNext("/\t/evil.example/"),
      safeNext("data:text/html,hi"),
    ]).toStrictEqual(["/", "/", "/", "/", "/", "/", "/", "/"]);
  });
});

describe(loginPath, () => {
  it("comes back to the page afterwards", () => {
    expect(loginPath("/?c=12")).toBe("/login?next=%2F%3Fc%3D12");
    expect(
      safeNext(
        new URL(loginPath("/?c=12"), "http://x").searchParams.get("next")
      )
    ).toBe("/?c=12");
  });

  it("needs no next for home or the login page itself", () => {
    expect([loginPath("/"), loginPath("/login?next=%2Fskills")]).toStrictEqual([
      "/login",
      "/login",
    ]);
  });
});

describe(leaveConsole, () => {
  it("leaves once until someone signs in again", () => {
    const visits: string[] = [];
    const uninstall = onLeaveConsole((to) => visits.push(to));
    leaveConsole("/login");
    leaveConsole("/login?next=%2Fskills");
    signedIn();
    leaveConsole("/login?next=%2Fsettings");
    uninstall();
    signedIn();
    expect(visits).toStrictEqual(["/login", "/login?next=%2Fsettings"]);
  });
});
