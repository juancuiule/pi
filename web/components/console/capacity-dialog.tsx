"use client";

// The Capacity dialog: when a create, send or resume hits a Capacity limit, the person picks a Conversation to pause
// (now, or after its current Run), and the call runs again once that one is paused. Nothing is paused without a pick.
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { CapacityShortage } from "@/lib/api";
import { capacityShortageOf, runApi } from "@/lib/api";
import { holdersOf, shortageText } from "@/lib/capacity";
import type { Holder } from "@/lib/capacity";
import { CapacityContext } from "@/lib/capacity-context";
import type { CapacityDialog, CapacityGuard } from "@/lib/capacity-context";
import { fetchConversations, useConversations } from "@/lib/queries";

const POLL_MS = 500;

const sleep = (ms: number) => {
  const done = Promise.withResolvers<boolean>();
  setTimeout(() => done.resolve(true), ms);
  return done.promise;
};

/** Poll until `id` has no Seat, or `cancelled()` says to stop; true when it was paused. */
const waitUntilPaused = async (
  id: number,
  cancelled: () => boolean
): Promise<boolean> => {
  if (cancelled()) {
    return false;
  }
  const conversations = await fetchConversations();
  const found = conversations.find((c) => c.id === id);
  if (
    found === undefined ||
    found.status === "paused" ||
    found.status === "archived"
  ) {
    return true;
  }
  await sleep(POLL_MS);
  return waitUntilPaused(id, cancelled);
};

interface Request {
  readonly shortage: CapacityShortage;
  /** True to run the call again, false to give up; absent when nothing here waits to retry. */
  readonly settle?: (retry: boolean) => void;
}

const HolderRow = ({
  holder,
  disabled,
  onPause,
}: {
  holder: Holder;
  disabled: boolean;
  onPause: (stopFirst: boolean) => void;
}) => (
  <li className="flex items-center gap-2 rounded-md border px-3 py-2">
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-medium" title={holder.title}>
        {holder.title}
      </span>
      <span className="text-muted-foreground text-xs">
        {holder.running ? "Working" : "Idle"}
        {holder.pausing ? " · Pausing after this run" : ""}
      </span>
    </span>
    {holder.running ? (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || holder.pausing}
          onClick={() => onPause(false)}
        >
          After this run
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onPause(true)}
        >
          Stop and pause
        </Button>
      </>
    ) : (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onPause(false)}
      >
        Pause
      </Button>
    )}
  </li>
);

export const CapacityGuardProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [request, setRequest] = useState<Request | undefined>();
  const [waitingFor, setWaitingFor] = useState<Holder | undefined>();
  const cancelledRef = useRef(false);
  const { data: conversations } = useConversations();

  const guard: CapacityGuard = useCallback(<A,>(call: () => Promise<A>) => {
    const attempt = async (): Promise<A> => {
      try {
        return await call();
      } catch (error) {
        const shortage = capacityShortageOf(error);
        if (shortage === undefined) {
          throw error;
        }
        const retry = Promise.withResolvers<boolean>();
        cancelledRef.current = false;
        setRequest({ shortage, settle: retry.resolve });
        if (!(await retry.promise)) {
          throw error;
        }
        return attempt();
      }
    };
    return attempt();
  }, []);

  const makeRoom = useCallback((shortage: CapacityShortage) => {
    cancelledRef.current = false;
    // Whatever waits for the room is not this dialog's to retry.
    setRequest({ shortage });
  }, []);

  const value = useMemo<CapacityDialog>(
    () => ({ guard, makeRoom }),
    [guard, makeRoom]
  );

  const close = (retry: boolean) => {
    cancelledRef.current = !retry;
    request?.settle?.(retry);
    setRequest(undefined);
    setWaitingFor(undefined);
  };

  const pause = async (holder: Holder, stopFirst: boolean) => {
    setWaitingFor(holder);
    const params = { params: { id: holder.id } };
    try {
      if (stopFirst) {
        await runApi((c) => c.conversations.stop(params));
      }
      await runApi((c) => c.conversations.pause(params));
      if (await waitUntilPaused(holder.id, () => cancelledRef.current)) {
        close(true);
      }
    } catch (error) {
      setWaitingFor(undefined);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const holders =
    request === undefined
      ? []
      : holdersOf(request.shortage, conversations ?? []);

  return (
    <CapacityContext.Provider value={value}>
      {children}
      <AlertDialog
        open={request !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            close(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Pause a conversation to continue
            </AlertDialogTitle>
            <AlertDialogDescription>
              {request === undefined ? null : shortageText(request.shortage)}{" "}
              {waitingFor === undefined
                ? "Paused conversations keep their files and can be resumed later."
                : `Waiting for “${waitingFor.title}” to pause, then this continues.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {holders.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing can be paused right now. Try again in a moment.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {holders.map((holder) => (
                <HolderRow
                  key={holder.id}
                  holder={holder}
                  disabled={waitingFor !== undefined}
                  onPause={(stopFirst) => {
                    void pause(holder, stopFirst);
                  }}
                />
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CapacityContext.Provider>
  );
};
