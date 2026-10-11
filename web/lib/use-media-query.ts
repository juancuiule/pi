"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Whether a CSS media query matches, live. `null` on the server and until mounted. */
export const useMediaQuery = (query: string): boolean | null => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => null
  );
};

const never = () => {
  // Nothing ever changes; there is no unsubscribe work.
};

/** True on the client, false on the server — for things that would mismatch hydration (theme). */
export const useMounted = (): boolean =>
  useSyncExternalStore(
    () => never,
    () => true,
    () => false
  );
