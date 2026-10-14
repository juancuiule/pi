"use client";

// What can be done to a Conversation in its state: Stop and Pause with a Seat, Resume when paused, Archive, and
// Unarchive when archived.
import type { ConversationSummary } from "effect-pi/api";
import { Archive, ArchiveRestore, Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConversationAction } from "@/lib/queries";
import type { ConversationAction } from "@/lib/queries";

export const ConversationActions = ({
  conversation,
}: {
  conversation: ConversationSummary;
}) => {
  const [confirming, setConfirming] = useState(false);
  const act = useConversationAction();
  const { status } = conversation;
  const hasSeat = status === "running" || status === "idle";
  const hasSandbox = conversation.sandbox !== "none";

  const run = (action: ConversationAction, onDone?: () => void) => {
    act.mutate(
      { id: conversation.id, action },
      {
        onSuccess: () => onDone?.(),
        onError: (error) => toast.error(error.message),
      }
    );
  };

  return (
    <>
      {status === "running" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={act.isPending}
          onClick={() => run("stop")}
        >
          <Square />
          Stop
        </Button>
      ) : null}
      {hasSeat && !conversation.pausing ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                disabled={act.isPending}
                onClick={() => run("pause")}
              >
                <Pause />
                Pause
              </Button>
            }
          />
          <TooltipContent>
            {status === "running"
              ? "Frees its resources once the current run ends"
              : "Frees its resources; its files stay for later"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {status === "paused" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={act.isPending}
          onClick={() => run("resume")}
        >
          <Play />
          Resume
        </Button>
      ) : null}
      {status === "archived" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={act.isPending}
          onClick={() => run("unarchive")}
        >
          <ArchiveRestore />
          Unarchive
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Archive conversation"
                disabled={act.isPending}
                onClick={() => setConfirming(true)}
              >
                <Archive />
              </Button>
            }
          />
          <TooltipContent>Archive conversation</TooltipContent>
        </Tooltip>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasSandbox
                ? "The agent stops and the files in its sandbox are deleted. You can still read it, and unarchive it to continue with an empty sandbox."
                : "The agent stops. You can still read it, and unarchive it to continue."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run("archive", () => setConfirming(false))}
            >
              {act.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
