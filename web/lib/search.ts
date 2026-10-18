"use client";

// The console's ⌘K search palette (components/console/search-palette.tsx).
import { useEffect, useState } from "react";

/** Whether a keydown toggles the palette: ⌘K or Ctrl+K. */
export const isSearchShortcut = (event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): boolean =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";

/** `value` once it has not changed for `delay` ms — the palette's debounce on the query. */
export const useDebouncedValue = <T>(value: T, delay: number): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
};
