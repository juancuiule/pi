import { describe, expect, it, vi } from "vitest";

import { makeSharedSubscriptions } from "./refcount";

describe(makeSharedSubscriptions, () => {
  it("starts once per key and stops with the last unsubscribe", () => {
    const stop = vi.fn<() => void>();
    const start = vi.fn<() => () => void>(() => stop);
    const subscribe = makeSharedSubscriptions<number>(start);

    const a = subscribe(1);
    const b = subscribe(1);
    expect(start).toHaveBeenCalledOnce();
    a();
    a();
    expect(stop).not.toHaveBeenCalled();
    b();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("ends a StrictMode mount, unmount, mount with exactly one live subscription", () => {
    const stops: number[] = [];
    let started = 0;
    const subscribe = makeSharedSubscriptions<number>(() => {
      started += 1;
      const n = started;
      return () => stops.push(n);
    });

    subscribe(1)();
    subscribe(1);
    expect(started).toBe(2);
    expect(stops).toStrictEqual([1]);
  });

  it("keeps keys independent", () => {
    const start = vi.fn<() => () => void>(() => vi.fn<() => void>());
    const subscribe = makeSharedSubscriptions<number>(start);
    subscribe(1);
    subscribe(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
