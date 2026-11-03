"use client";

// A list row that swipes sideways to reveal actions, as iOS lists do. The row follows the pointer 1:1 once a press
// moves sideways (a vertical move is left to the scroll), rubber-bands past its bounds, and on release springs to
// where its velocity projects it: closed, open, or a full swipe that runs the side's edge action. A press during the
// spring catches the row where it is. A trackpad's horizontal scroll drives the same offset. Each frame writes one
// CSS variable (`--swipe-x`) on the row, so React renders only when the row opens, closes or arms.
//
// The gesture is a shortcut, never the only way: the revealed buttons are hidden from assistive technology and the
// tab order, and every action is also in the row's menu (`ConversationRow`).
import type { LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import {
  ACTION_WIDTH,
  HORIZONTAL_BIAS,
  SWIPE_SLOP,
  atRest,
  isArmed,
  offsetOf,
  resist,
  resolveRelease,
  stepSpring,
  velocityOf,
} from "@/lib/swipe";
import type {
  Sample,
  SpringState,
  SwipeLayout,
  SwipeRest,
  SwipeSide,
} from "@/lib/swipe";
import { cn } from "@/lib/utils";

export interface SwipeAction {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Background and text classes of its button. */
  readonly tone: string;
  /** Slide the row off-screen before running it, for an action that removes the row. */
  readonly dismiss?: boolean;
  /** Runs the action; a dismissed row that is still listed once it settles slides back. */
  readonly run: () => unknown;
}

const NONE: readonly SwipeAction[] = [];

/** Only one row in the page stays open: opening one closes the last. */
let closeOpen: (() => void) | null = null;

/** A horizontal wheel gap longer than this ends a trackpad swipe, in ms. */
const WHEEL_IDLE = 140;

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The swipe action button an event came from, if any. */
const actionKeyOf = (target: EventTarget | null): string | undefined =>
  target instanceof Element
    ? (target.closest<HTMLElement>("[data-swipe-action]")?.dataset
        .swipeAction ?? undefined)
    : undefined;

type Press =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pending" | "dragging";
      readonly pointer: number;
      readonly x: number;
      readonly y: number;
      readonly base: number;
      readonly samples: Sample[];
      /** Pressed on a revealed action: a tap runs it, a drag still moves the row. */
      readonly onAction: boolean;
    };

/** Grow factor of one revealed button: armed, the edge action takes the whole width, as iOS shows it will run. */
const growOf = (armed: boolean, edge: boolean) => {
  if (!armed) {
    return "grow";
  }
  return edge ? "grow-[100]" : "grow-0";
};

const ActionButtons = ({
  actions,
  side,
  armed,
}: {
  actions: readonly SwipeAction[];
  side: SwipeSide;
  armed: boolean;
}) => (
  <div
    aria-hidden
    className={cn(
      "absolute inset-y-0 flex overflow-hidden",
      side === "leading"
        ? "left-0 w-[max(0px,var(--swipe-x))]"
        : "right-0 w-[max(0px,calc(-1*var(--swipe-x)))]"
    )}
  >
    {actions.map((action, index) => {
      const edge =
        side === "leading" ? index === 0 : index === actions.length - 1;
      const Icon = action.icon;
      return (
        <button
          key={action.key}
          type="button"
          tabIndex={-1}
          data-swipe-action={action.key}
          className={cn(
            // oxlint-disable-next-line shadcn/no-arbitrary-values -- flex-grow alone: a wider transition would lag the per-frame width
            "flex min-w-0 basis-0 flex-col items-center justify-center gap-0.5 overflow-hidden text-xs font-medium whitespace-nowrap motion-safe:transition-[flex-grow] motion-safe:duration-200 motion-safe:ease-out",
            action.tone,
            growOf(armed, edge)
          )}
        >
          <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
          {action.label}
        </button>
      );
    })}
  </div>
);

export const SwipeRow = ({
  leading = NONE,
  trailing = NONE,
  onSwipeStart,
  className,
  children,
}: {
  /** A press became a swipe: anything the press opened (a menu on pointer-down) should close. */
  onSwipeStart?: () => void;
  /** Revealed by a left-to-right swipe; the first is at the edge and runs on a full swipe. */
  leading?: readonly SwipeAction[];
  /** Revealed by a right-to-left swipe; the last is at the edge and runs on a full swipe. */
  trailing?: readonly SwipeAction[];
  className?: string;
  children: ReactNode;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const spring = useRef<SpringState>({ x: 0, v: 0 });
  const frame = useRef<number | null>(null);
  const press = useRef<Press>({ kind: "idle" });
  const swallowClick = useRef(false);
  const wheel = useRef<{ timer: number | null; last: number }>({
    timer: null,
    last: 0,
  });
  const [open, setOpen] = useState<SwipeSide | null>(null);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const closeSelf = useRef<(() => void) | null>(null);
  // The latest actions, read by handlers that outlive a render.
  const actions = useRef({ leading, trailing });
  useLayoutEffect(() => {
    actions.current = { leading, trailing };
  }, [leading, trailing]);

  const layoutOf = useCallback((): SwipeLayout => {
    const { current } = actions;
    return {
      width: root.current?.offsetWidth ?? 0,
      leading: current.leading.length * ACTION_WIDTH,
      trailing: current.trailing.length * ACTION_WIDTH,
      leadingCommits: current.leading.length > 0,
      trailingCommits: current.trailing.length > 0,
    };
  }, []);

  const write = useCallback((x: number) => {
    spring.current = { ...spring.current, x };
    root.current?.style.setProperty("--swipe-x", `${x}px`);
  }, []);

  const arm = useCallback((next: boolean) => {
    if (armedRef.current === next) {
      return;
    }
    armedRef.current = next;
    setArmed(next);
    // A tick on crossing, where the device has one (Android): the same frame as the button's growth.
    if (next && typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(8);
    }
  }, []);

  const stop = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  /** Spring from the live offset and velocity to `target`; reduced motion jumps there. */
  const animateTo = useCallback(
    (target: number, velocity: number, onRest?: () => void) => {
      stop();
      if (reducedMotion()) {
        spring.current = { x: target, v: 0 };
        write(target);
        onRest?.();
        return;
      }
      spring.current = { x: spring.current.x, v: velocity };
      // A flick into an open position overshoots a little; everything else settles without bounce.
      const damping = target !== 0 && Math.abs(velocity) > 600 ? 0.85 : 1;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        const next = stepSpring(spring.current, target, dt, 0.35, damping);
        if (atRest(next, target)) {
          spring.current = { x: target, v: 0 };
          write(target);
          frame.current = null;
          onRest?.();
          return;
        }
        spring.current = next;
        write(next.x);
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    },
    [stop, write]
  );

  const close = useCallback(
    (velocity = 0) => {
      arm(false);
      setOpen(null);
      if (closeOpen === closeSelf.current) {
        closeOpen = null;
      }
      animateTo(0, velocity);
    },
    [animateTo, arm]
  );
  useLayoutEffect(() => {
    closeSelf.current = () => close();
  }, [close]);

  const run = useCallback(
    (action: SwipeAction, side: SwipeSide, velocity: number) => {
      arm(false);
      setOpen(null);
      if (closeOpen === closeSelf.current) {
        closeOpen = null;
      }
      if (action.dismiss === true) {
        // Off-screen first, then the action; a row still listed once it settles slides back.
        const away = offsetOf({ kind: "commit", side }, layoutOf(), true);
        animateTo(away, velocity, async () => {
          try {
            await action.run();
          } catch {
            // The action reports its own failure; the row comes back either way.
          }
          if (root.current !== null) {
            animateTo(0, 0);
          }
        });
        return;
      }
      animateTo(0, velocity);
      action.run();
    },
    [animateTo, arm, layoutOf]
  );

  const settle = useCallback(
    (rest: SwipeRest, velocity: number) => {
      if (rest.kind === "commit") {
        const side = actions.current[rest.side];
        const edge = rest.side === "leading" ? side[0] : side.at(-1);
        if (edge !== undefined) {
          run(edge, rest.side, velocity);
          return;
        }
      }
      if (rest.kind === "open") {
        arm(false);
        setOpen(rest.side);
        if (closeOpen !== null && closeOpen !== closeSelf.current) {
          closeOpen();
        }
        closeOpen = closeSelf.current;
        animateTo(offsetOf(rest, layoutOf(), false), velocity);
        return;
      }
      close(velocity);
    },
    [animateTo, arm, close, layoutOf, run]
  );

  /** Show a raw drag position: free within the row's width on a side with actions, rubber-banded past it. */
  const follow = useCallback(
    (raw: number) => {
      const layout = layoutOf();
      const max = layout.leading > 0 ? layout.width : 0;
      const min = layout.trailing > 0 ? -layout.width : 0;
      const x = resist(raw, min, max, Math.max(layout.width, 1));
      write(x);
      arm(isArmed(x, layout));
    },
    [arm, layoutOf, write]
  );

  // An open row whose actions changed (its conversation paused, say) closes rather than show the wrong width.
  const shape = `${leading.length}:${trailing.length}`;
  const shown = useRef(shape);
  useEffect(() => {
    if (shown.current !== shape) {
      shown.current = shape;
      if (closeOpen !== null && closeOpen === closeSelf.current) {
        closeOpen();
      }
    }
  }, [shape]);

  // Close when a press lands outside an open row, or on Escape.
  useEffect(() => {
    if (open === null) {
      return;
    }
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        root.current?.contains(event.target) !== true
      ) {
        close();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);

  // A trackpad's horizontal scroll. Not passive, so the browser's own horizontal gesture (back, forward) stays out.
  useEffect(() => {
    const element = root.current;
    if (element === null) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
        return;
      }
      event.preventDefault();
      const state = wheel.current;
      const now = event.timeStamp;
      // The momentum tail of a swipe that already settled is swallowed, not a new swipe.
      if (state.timer === null && now - state.last < WHEEL_IDLE) {
        state.last = now;
        return;
      }
      state.last = now;
      if (state.timer === null) {
        stop();
      } else {
        window.clearTimeout(state.timer);
      }
      follow(spring.current.x - event.deltaX);
      state.timer = window.setTimeout(() => {
        state.timer = null;
        state.last = performance.now();
        settle(resolveRelease(spring.current.x, 0, layoutOf()), 0);
      }, WHEEL_IDLE);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [follow, layoutOf, settle, stop]);

  useEffect(() => {
    const state = wheel.current;
    return () => {
      stop();
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
      }
      if (closeOpen === closeSelf.current) {
        closeOpen = null;
      }
    };
  }, [stop]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || press.current.kind !== "idle") {
      return;
    }
    // Catch the row where it is: the spring stops and the drag starts from its live offset.
    stop();
    press.current = {
      kind: "pending",
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: spring.current.x,
      samples: [{ x: spring.current.x, t: event.timeStamp }],
      onAction: actionKeyOf(event.target) !== undefined,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const { current } = press;
    if (current.kind === "idle" || current.pointer !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.kind === "pending") {
      if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) >= Math.abs(dx)) {
        // A scroll: let it go, and close an open row as iOS does.
        press.current = { kind: "idle" };
        if (open !== null) {
          close();
        } else if (frame.current === null && spring.current.x !== 0) {
          settle(resolveRelease(spring.current.x, 0, layoutOf()), 0);
        }
        return;
      }
      if (
        Math.abs(dx) <= SWIPE_SLOP ||
        Math.abs(dx) < Math.abs(dy) * HORIZONTAL_BIAS
      ) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      press.current = { ...current, kind: "dragging" };
      onSwipeStart?.();
      if (root.current !== null) {
        root.current.dataset.dragging = "";
      }
    }
    // The slop is taken off, so the row starts from where it was rather than jumping 10px.
    const x = current.base + dx - Math.sign(dx) * SWIPE_SLOP;
    current.samples.push({ x, t: event.timeStamp });
    if (current.samples.length > 8) {
      current.samples.shift();
    }
    follow(x);
  };

  const release = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled: boolean
  ) => {
    const { current } = press;
    if (current.kind === "idle" || current.pointer !== event.pointerId) {
      return;
    }
    press.current = { kind: "idle" };
    if (current.kind === "pending") {
      if (current.onAction) {
        // The click that follows runs the action.
        return;
      }
      if (open !== null && !cancelled) {
        // A tap on an open row closes it instead of following the link.
        swallowClick.current = true;
        close();
      } else if (frame.current === null && spring.current.x !== 0) {
        // A tap that caught the spring mid-flight sends the row on to its rest.
        settle(resolveRelease(spring.current.x, 0, layoutOf()), 0);
      }
      return;
    }
    if (root.current !== null) {
      delete root.current.dataset.dragging;
    }
    swallowClick.current = true;
    const velocity = cancelled ? 0 : velocityOf(current.samples);
    settle(resolveRelease(spring.current.x, velocity, layoutOf()), velocity);
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const key = actionKeyOf(event.target);
    if (key !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      const side: SwipeSide = leading.some((action) => action.key === key)
        ? "leading"
        : "trailing";
      const action = [...leading, ...trailing].find((each) => each.key === key);
      if (action !== undefined) {
        run(action, side, 0);
      }
      return;
    }
    if (swallowClick.current) {
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={root}
      className={cn(
        "group/swipe relative touch-pan-y overflow-hidden overscroll-x-none rounded-md select-none [--swipe-x:0px] [-webkit-touch-callout:none]",
        className
      )}
      data-open={open ?? undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => release(event, false)}
      onPointerCancel={(event) => release(event, true)}
      onLostPointerCapture={(event) => {
        // Touch captures to the pressed child implicitly; moving the capture here fires this from that child.
        if (event.target === event.currentTarget) {
          release(event, true);
        }
      }}
      onClickCapture={onClickCapture}
      // A link's native drag would cancel the pointer stream mid-swipe.
      onDragStartCapture={(event) => event.preventDefault()}
    >
      {leading.length > 0 ? (
        <ActionButtons actions={leading} side="leading" armed={armed} />
      ) : null}
      {trailing.length > 0 ? (
        <ActionButtons actions={trailing} side="trailing" armed={armed} />
      ) : null}
      <div className="bg-background relative [transform:translate3d(var(--swipe-x),0,0)] group-data-[dragging]/swipe:will-change-transform">
        {children}
      </div>
    </div>
  );
};
