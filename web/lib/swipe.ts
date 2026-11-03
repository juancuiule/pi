// The physics and decisions behind a swipeable list row, kept pure so they are tested without a DOM: how far the
// row follows past its bounds, where a release lands, and the spring that carries it there. `swipe-row.tsx` owns
// the pointer, wheel and frame loop around them.

/** Movement before a press becomes a swipe or a scroll, in px. Below it a press is still a tap. */
export const SWIPE_SLOP = 10;

/** Horizontal movement must beat vertical by this factor to claim the press as a swipe. */
export const HORIZONTAL_BIAS = 1.2;

/** Width of one revealed action button, in px. */
export const ACTION_WIDTH = 72;

/** Release speed toward the side, in px/s, that lets a flick commit a full swipe from the open position. */
export const FLICK_VELOCITY = 800;

/** Release speed back toward rest, in px/s, that closes the row whatever its position. */
export const REVERSE_VELOCITY = 200;

/**
 * iOS's rubber-band: just past a bound the row follows at `constant` of the pointer's speed, then less and less,
 * approaching `dimension` without reaching it.
 */
export const rubberband = (
  overshoot: number,
  dimension: number,
  constant = 0.55
): number =>
  (overshoot * dimension * constant) /
  (dimension + constant * Math.abs(overshoot));

/** `raw` inside `[min, max]` as is; outside, rubber-banded past the bound it crossed. */
export const resist = (
  raw: number,
  min: number,
  max: number,
  dimension: number
): number => {
  if (raw > max) {
    return max + rubberband(raw - max, dimension);
  }
  if (raw < min) {
    return min + rubberband(raw - min, dimension);
  }
  return raw;
};

/**
 * How far momentum carries a release before it stops, in px: exponential decay, as Apple's sample code projects
 * scroll deceleration. 0.99 is snappier than scrolling's 0.998, which suits a short row.
 */
export const project = (velocity: number, deceleration = 0.99): number =>
  ((velocity / 1000) * deceleration) / (1 - deceleration);

/** Distance at which a swipe arms its side's full-swipe action: past the open buttons, and past most of the row. */
export const commitDistance = (width: number, openWidth: number): number =>
  Math.max(openWidth + 48, width * 0.6);

export type SwipeSide = "leading" | "trailing";

export interface SwipeLayout {
  /** The row's width, in px. */
  readonly width: number;
  /** Revealed width of each side's open position; 0 for a side without actions. */
  readonly leading: number;
  readonly trailing: number;
  /** Whether a full swipe on each side commits its edge action. */
  readonly leadingCommits: boolean;
  readonly trailingCommits: boolean;
}

/** Where a released row goes: closed, open on one side, or committing that side's edge action. */
export type SwipeRest =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly side: SwipeSide }
  | { readonly kind: "commit"; readonly side: SwipeSide };

const sideOf = (offset: number): SwipeSide | undefined => {
  if (offset > 0) {
    return "leading";
  }
  return offset < 0 ? "trailing" : undefined;
};

/** Whether `offset` is far enough to commit a full swipe if released now. */
export const isArmed = (offset: number, layout: SwipeLayout): boolean => {
  const side = sideOf(offset);
  if (side === undefined) {
    return false;
  }
  const open = side === "leading" ? layout.leading : layout.trailing;
  const commits =
    side === "leading" ? layout.leadingCommits : layout.trailingCommits;
  return (
    commits &&
    open > 0 &&
    Math.abs(offset) >= commitDistance(layout.width, open)
  );
};

/**
 * Where a row released at `offset` with `velocity` (px/s, positive to the right) comes to rest. Velocity decides
 * before position: moving back toward rest closes, so a swipe can be taken back mid-gesture. A full swipe commits
 * when armed, or when flicked onward from at least the open position; otherwise the projected landing point picks
 * open or closed.
 */
export const resolveRelease = (
  offset: number,
  velocity: number,
  layout: SwipeLayout
): SwipeRest => {
  const side = sideOf(offset);
  if (side === undefined) {
    return { kind: "closed" };
  }
  const open = side === "leading" ? layout.leading : layout.trailing;
  if (open === 0) {
    return { kind: "closed" };
  }
  const direction = side === "leading" ? 1 : -1;
  const toward = velocity * direction;
  if (toward < -REVERSE_VELOCITY) {
    return { kind: "closed" };
  }
  const commits =
    side === "leading" ? layout.leadingCommits : layout.trailingCommits;
  const distance = Math.abs(offset);
  const projected = Math.abs(offset + project(velocity));
  const commitAt = commitDistance(layout.width, open);
  if (
    commits &&
    (distance >= commitAt ||
      (distance >= open && toward >= FLICK_VELOCITY && projected >= commitAt))
  ) {
    return { kind: "commit", side };
  }
  return projected >= open / 2 ? { kind: "open", side } : { kind: "closed" };
};

/** The offset a rest sits at: 0, an open side's width, or the whole row's width off-screen for a commit. */
export const offsetOf = (
  rest: SwipeRest,
  layout: SwipeLayout,
  dismiss: boolean
): number => {
  if (rest.kind === "closed") {
    return 0;
  }
  const direction = rest.side === "leading" ? 1 : -1;
  if (rest.kind === "commit") {
    return dismiss ? direction * layout.width : 0;
  }
  return (
    direction * (rest.side === "leading" ? layout.leading : layout.trailing)
  );
};

export interface Sample {
  readonly x: number;
  readonly t: number;
}

/** Velocity in px/s over the samples of the last `window` ms; 0 with fewer than two. */
export const velocityOf = (
  samples: readonly Sample[],
  window = 100
): number => {
  const last = samples.at(-1);
  if (last === undefined) {
    return 0;
  }
  const first = samples.find((sample) => last.t - sample.t <= window);
  if (first === undefined || last.t === first.t) {
    return 0;
  }
  return ((last.x - first.x) / (last.t - first.t)) * 1000;
};

export interface SpringState {
  readonly x: number;
  readonly v: number;
}

/**
 * One step of a spring toward `target` over `dt` seconds, in Apple's terms: `response` is roughly the seconds to
 * get there, `damping` 1 settles without overshoot and less bounces. Substepped so a long frame stays stable.
 */
export const stepSpring = (
  state: SpringState,
  target: number,
  dt: number,
  response = 0.35,
  damping = 1
): SpringState => {
  const omega = (2 * Math.PI) / response;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  let { x, v } = state;
  for (let step = 0; step < steps; step += 1) {
    const a = -omega * omega * (x - target) - 2 * damping * omega * v;
    v += a * h;
    x += v * h;
  }
  return { x, v };
};

/** Whether a spring is close enough to `target` and slow enough to stop. */
export const atRest = (state: SpringState, target: number): boolean =>
  Math.abs(state.x - target) < 0.5 && Math.abs(state.v) < 10;
