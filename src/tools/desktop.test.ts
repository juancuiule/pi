import { describe, expect, it } from "vitest";

import {
  clickCommand,
  dragCommand,
  keyCommand,
  scrollCommand,
  typeCommand,
} from "./desktop.ts";

describe("desktop commands", () => {
  it("clicks with the left button once by default, at rounded coordinates", () => {
    expect(clickCommand({ x: 10.4, y: 20.6 })).toStrictEqual([
      "xdotool",
      "mousemove",
      "--sync",
      "10",
      "21",
      "click",
      "--repeat",
      "1",
      "1",
    ]);
  });

  it("double clicks with the right button", () => {
    expect(
      clickCommand({ x: 1, y: 2, button: "right", clicks: 2 }).slice(-3)
    ).toStrictEqual(["--repeat", "2", "3"]);
  });

  it("passes typed text as one argument after --, so it is never parsed", () => {
    expect(typeCommand("-rf $HOME; echo 'hi'")).toStrictEqual([
      "xdotool",
      "type",
      "--delay",
      "12",
      "--",
      "-rf $HOME; echo 'hi'",
    ]);
  });

  it("splits key sequences on whitespace", () => {
    expect(keyCommand(" ctrl+l  Return ")).toStrictEqual([
      "xdotool",
      "key",
      "--",
      "ctrl+l",
      "Return",
    ]);
  });

  it("maps scroll directions to X11 buttons 4 to 7", () => {
    expect(
      scrollCommand({ x: 0, y: 0, direction: "down" }).slice(-3)
    ).toStrictEqual(["--repeat", "3", "5"]);
    expect(
      scrollCommand({ x: 0, y: 0, direction: "left", amount: 1 }).slice(-3)
    ).toStrictEqual(["--repeat", "1", "6"]);
  });

  it("drags with the left button held", () => {
    expect(dragCommand({ fromX: 1, fromY: 2, toX: 3, toY: 4 })).toStrictEqual([
      "xdotool",
      "mousemove",
      "--sync",
      "1",
      "2",
      "mousedown",
      "1",
      "mousemove",
      "--sync",
      "3",
      "4",
      "mouseup",
      "1",
    ]);
  });
});
