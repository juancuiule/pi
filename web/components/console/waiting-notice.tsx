"use client";

// Shown while the agent's Upgrade waits for room: the person can free a sandbox, or cancel the Upgrade.
import type { ConversationSummary } from "effect-pi/api";
import { Hourglass } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { WAITING_FOR, waitingShortage } from "@/lib/capacity";
import { useMakeRoom } from "@/lib/capacity-context";
import { useCancelWait, useCapacity } from "@/lib/queries";

export const WaitingNotice = ({
  conversation,
}: {
  conversation: ConversationSummary;
}) => {
  const { data: usage } = useCapacity();
  const makeRoom = useMakeRoom();
  const cancel = useCancelWait();
  const shortage =
    usage === undefined ? undefined : waitingShortage(usage, conversation.id);
  if (shortage === undefined) {
    return null;
  }
  return (
    <div className="bg-muted/50 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm md:px-4">
      <Hourglass aria-hidden className="text-muted-foreground size-4" />
      <span className="flex-1">
        The agent is waiting for {WAITING_FOR[shortage.resource]}. Pause another
        conversation to make room.
      </span>
      <Button variant="outline" size="sm" onClick={() => makeRoom(shortage)}>
        Make room
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate(conversation.id, {
            onError: (error) =>
              toast.error(error.message, { duration: Infinity }),
          })
        }
      >
        Cancel upgrade
      </Button>
    </div>
  );
};
