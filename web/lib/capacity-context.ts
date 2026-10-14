"use client";

import { createContext, useContext } from "react";

/**
 * Runs an API call that takes Capacity (create, send, resume). When a limit stops it, the Capacity dialog lets the
 * person pick a Conversation to pause, waits for it, and runs the call again; the promise settles with that retry,
 * or rejects with the original failure when the person cancels.
 */
export type CapacityGuard = <A>(call: () => Promise<A>) => Promise<A>;

export const CapacityContext = createContext<CapacityGuard>((call) => call());

export const useCapacityGuard = () => useContext(CapacityContext);
