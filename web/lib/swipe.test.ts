import { describe, expect, it } from "vitest";

import {
  atRest,
  commitDistance,
  isArmed,
  offsetOf,
  project,
  resist,
  resolveRelease,
  rubberband,
  stepSpring,
  velocityOf,
} from "./swipe";
import type { SpringState, SwipeLayout } from "./swipe";

// A 260px sidebar row: Pin on the leading side, Pause and Archive on the trailing side.
const layout: SwipeLayout = {
  width: 260,
  leading: 72,
  trailing: 144,
  leadingCommits: true,
  trailingCommits: true,
};

describe(rubberband, () => {
  it("follows at about the constant near the bound, less further out, never reaching the dimension", () => {
    const near = rubberband(10, 260);
    const far = rubberband(1000, 260);
    expect(near).toBeGreaterThan(5);
    expect(near).toBeLessThan(10);
    expect(far).toBeLessThan(260);
    expect(far / 1000).toBeLessThan(near / 10);
    expect(rubberband(-10, 260)).toBeCloseTo(-near);
  });
});

describe(resist, () => {
  it("passes values within bounds and resists past them", () => {
    expect(resist(-50, -260, 0, 260)).toBe(-50);
    expect(resist(40, -260, 0, 260)).toBeLessThan(40);
    expect(resist(40, -260, 0, 260)).toBeGreaterThan(0);
  });
});

describe(resolveRelease, () => {
  it("closes on a short drag and opens past half the actions", () => {
    expect(resolveRelease(-30, 0, layout)).toStrictEqual({ kind: "closed" });
    expect(resolveRelease(-80, 0, layout)).toStrictEqual({
      kind: "open",
      side: "trailing",
    });
    expect(resolveRelease(40, 0, layout)).toStrictEqual({
      kind: "open",
      side: "leading",
    });
  });

  it("opens a short flick that momentum carries past half the actions", () => {
    expect(resolveRelease(-30, -600, layout)).toStrictEqual({
      kind: "open",
      side: "trailing",
    });
  });

  it("closes when the release moves back toward rest, even past the commit distance", () => {
    expect(resolveRelease(-220, 400, layout)).toStrictEqual({ kind: "closed" });
  });

  it("commits once armed, or on a flick onward from the open position", () => {
    const armedAt = commitDistance(layout.width, layout.trailing);
    expect(resolveRelease(-armedAt, 0, layout)).toStrictEqual({
      kind: "commit",
      side: "trailing",
    });
    expect(resolveRelease(-150, -1200, layout)).toStrictEqual({
      kind: "commit",
      side: "trailing",
    });
    // The same flick from closed only opens: a flick alone never archives.
    expect(resolveRelease(-20, -1200, layout).kind).toBe("open");
  });

  it("never opens or commits a side without actions", () => {
    const trailingOnly = { ...layout, leading: 0, leadingCommits: false };
    expect(resolveRelease(200, 2000, trailingOnly)).toStrictEqual({
      kind: "closed",
    });
  });
});

describe(isArmed, () => {
  it("arms past the commit distance on a side that commits", () => {
    const at = commitDistance(layout.width, layout.leading);
    expect(isArmed(at - 1, layout)).toBeFalsy();
    expect(isArmed(at, layout)).toBeTruthy();
    expect(isArmed(at, { ...layout, leadingCommits: false })).toBeFalsy();
  });
});

describe(offsetOf, () => {
  it("rests at 0, an open side's width, or off-screen for a dismissing commit", () => {
    expect(offsetOf({ kind: "closed" }, layout, false)).toBe(0);
    expect(offsetOf({ kind: "open", side: "trailing" }, layout, false)).toBe(
      -144
    );
    expect(offsetOf({ kind: "open", side: "leading" }, layout, false)).toBe(72);
    expect(offsetOf({ kind: "commit", side: "trailing" }, layout, true)).toBe(
      -260
    );
    expect(offsetOf({ kind: "commit", side: "leading" }, layout, false)).toBe(
      0
    );
  });
});

describe(velocityOf, () => {
  it("reads px/s over the recent window only", () => {
    expect(velocityOf([])).toBe(0);
    expect(
      velocityOf([
        { x: 0, t: 0 },
        { x: 500, t: 400 },
        { x: 510, t: 410 },
        { x: 560, t: 460 },
      ])
    ).toBeCloseTo(1000);
  });
});

describe(project, () => {
  it("carries a release forward in its direction", () => {
    expect(project(1000)).toBeCloseTo(99);
    expect(project(-1000)).toBeCloseTo(-99);
    expect(project(0)).toBe(0);
  });
});

describe(stepSpring, () => {
  it("settles a critically damped spring on its target without overshoot", () => {
    let state: SpringState = { x: -144, v: 0 };
    let lowest = state.x;
    for (let frame = 0; frame < 120 && !atRest(state, 0); frame += 1) {
      state = stepSpring(state, 0, 1 / 60);
      lowest = Math.max(lowest, state.x);
    }
    expect(atRest(state, 0)).toBeTruthy();
    expect(lowest).toBeLessThanOrEqual(0.5);
  });

  it("carries the release velocity into the motion", () => {
    const still = stepSpring({ x: -100, v: 0 }, -144, 1 / 60);
    const thrown = stepSpring({ x: -100, v: -1500 }, -144, 1 / 60);
    expect(thrown.x).toBeLessThan(still.x);
  });
});
