"use client";

import { useEffect, useState } from "react";

/** A clock that re-renders every 30s so relative timestamps stay fresh. */
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
};
