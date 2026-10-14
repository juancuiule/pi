"use client";

import { createContext, useContext } from "react";

import type { CapacityShortage } from "./api";

/**
 * Runs an API call that takes Capacity (create, send, resume, upgrade). When a limit stops it, the Capacity dialog
 * lets the person pick a Conversation to pause, waits for it, and runs the call again; the promise settles with that
 * retry, or rejects with the original failure when the person cancels.
 */
export type CapacityGuard = <A>(call: () => Promise<A>) => Promise<A>;

export interface CapacityDialog {
  readonly guard: CapacityGuard;
  /** Open the dialog for a shortage something else waits on (the agent's Upgrade); picking a Conversation pauses it. */
  readonly makeRoom: (shortage: CapacityShortage) => void;
}

export const CapacityContext = createContext<CapacityDialog>({
  guard: (call) => call(),
  makeRoom: () => null,
});

export const useCapacityGuard = () => useContext(CapacityContext).guard;

export const useMakeRoom = () => useContext(CapacityContext).makeRoom;
