"use client";

// Every Capacity resource's holders and waiters, with the same pause actions as the Capacity dialog and a way out
// for a waiting Upgrade: make room, or cancel it.
import { toast } from "sonner";

import { HolderRow } from "@/components/console/holder-row";
import { PageHeader } from "@/components/console/page-header";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CapacityShortage } from "@/lib/api";
import { conversationTitleOf } from "@/lib/artifacts";
import { holdersOf, shortageText, waitingShortage } from "@/lib/capacity";
import { useMakeRoom } from "@/lib/capacity-context";
import {
  useCancelWait,
  useCapacity,
  useConversationAction,
  useConversations,
} from "@/lib/queries";

const SECTION_LABEL = {
  seat: "Seats",
  shell: "Shell sandboxes",
  desktop: "Desktop sandboxes",
} as const;

const WAIT_LABEL = {
  seat: "a seat",
  shell: "a shell sandbox",
  desktop: "a desktop sandbox",
} as const;

const CapacityPage = () => {
  const { data: usage } = useCapacity();
  const { data: conversations } = useConversations();
  const act = useConversationAction();
  const cancelWait = useCancelWait();
  const makeRoom = useMakeRoom();

  // The 2s polls refresh the row; the dialog's waitUntilPaused is its own retry machinery, not needed here.
  const pause = async (id: number, stopFirst: boolean) => {
    try {
      if (stopFirst) {
        await act.mutateAsync({ id, action: "stop" });
      }
      await act.mutateAsync({ id, action: "pause" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), {
        duration: Infinity,
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>Capacity · effect-pi</title>
      <PageHeader title="Capacity" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {usage?.map((resource) => {
            const shortage: CapacityShortage = {
              resource: resource.resource,
              limit: resource.limit,
              holders: resource.holders,
            };
            const holders = holdersOf(shortage, conversations ?? []);
            const full = resource.holders.length >= resource.limit;
            return (
              <section
                key={resource.resource}
                aria-labelledby={`capacity-${resource.resource}`}
                className="flex flex-col gap-2"
              >
                <h2
                  id={`capacity-${resource.resource}`}
                  className="font-heading text-sm font-semibold"
                >
                  {SECTION_LABEL[resource.resource]}
                </h2>
                <p className="text-muted-foreground text-xs">
                  {resource.holders.length} of {resource.limit} in use
                  {full ? ` · ${shortageText(shortage)}` : ""}
                </p>
                {holders.length === 0 ? null : (
                  <ul className="flex flex-col gap-2">
                    {holders.map((holder) => (
                      <HolderRow
                        key={holder.id}
                        holder={holder}
                        disabled={act.isPending}
                        onPause={(stopFirst) => {
                          void pause(holder.id, stopFirst);
                        }}
                      />
                    ))}
                  </ul>
                )}
                <ul className="flex flex-col gap-2">
                  {resource.waiting.map((id) => {
                    const waiting = waitingShortage(usage, id);
                    const title = conversationTitleOf(conversations, id);
                    return (
                      <li
                        key={id}
                        className="flex items-center gap-2 rounded-md border px-3 py-2"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            className="truncate text-sm font-medium"
                            title={title}
                          >
                            {title}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            Waiting for {WAIT_LABEL[resource.resource]}
                          </span>
                        </span>
                        {waiting === undefined ? null : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => makeRoom(waiting)}
                          >
                            Make room
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancelWait.isPending}
                          onClick={() =>
                            cancelWait.mutate(id, {
                              onError: (error) =>
                                toast.error(error.message, {
                                  duration: Infinity,
                                }),
                            })
                          }
                        >
                          Cancel upgrade
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
};

export default CapacityPage;
