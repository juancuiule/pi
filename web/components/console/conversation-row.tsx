"use client";

// A sidebar row's actions around its link: Pin by a left-to-right swipe, Pause or Resume and Archive by a
// right-to-left one (a full swipe runs the edge action: Pin, or Archive), and the same actions in a menu that a
// hover, focus, right-click or the keyboard's context-menu key opens. Archive without Workspace files is undone
// from its toast; one that deletes files asks first, since Unarchive cannot bring them back.
import type { ConversationSummary } from "effect-pi/api";
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  Pause,
  Pin,
  PinOff,
  Play,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConversationAction, usePinConversation } from "@/lib/queries";
import type { ConversationAction } from "@/lib/queries";
import { ROW_ACTION_LABEL, rowActionsOf } from "@/lib/row-actions";
import type { RowAction } from "@/lib/row-actions";
import { cn } from "@/lib/utils";

import { ArchiveDialog } from "./conversation-actions";
import { SwipeRow } from "./swipe-row";
import type { SwipeAction } from "./swipe-row";

const ICON: Record<RowAction, LucideIcon> = {
  pin: Pin,
  unpin: PinOff,
  pause: Pause,
  resume: Play,
  archive: Archive,
  unarchive: ArchiveRestore,
};

/**
 * Solid fills under the page's background color as text: the fills are dark in light mode and light in dark mode,
 * so the label keeps its contrast in both. Pin is amber, the Seat's lifecycle neutral, Archive destructive.
 */
const TONE: Record<RowAction, string> = {
  pin: "bg-warning text-background",
  unpin: "bg-warning text-background",
  pause: "bg-muted-foreground text-background",
  resume: "bg-muted-foreground text-background",
  archive: "bg-destructive text-background",
  unarchive: "bg-muted-foreground text-background",
};

export const ConversationRow = ({
  conversation,
  resuming,
  children,
}: {
  conversation: ConversationSummary;
  /** A resume is in flight, so Resume is not offered again. */
  resuming: boolean;
  /** The row's link. */
  children: ReactNode;
}) => {
  const act = useConversationAction();
  const pin = usePinConversation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const hasSandbox = conversation.sandbox !== "none";
  const { id, title } = conversation;
  const { leading, trailing } = rowActionsOf(conversation, resuming);
  const LeadingIcon = ICON[leading];

  /** Run a lifecycle action; true when it went through, a lasting error toast otherwise. */
  const lifecycle = async (action: ConversationAction): Promise<boolean> => {
    try {
      await act.mutateAsync({ id, action });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), {
        duration: Infinity,
      });
      return false;
    }
  };

  const archive = async () => {
    if (!(await lifecycle("archive"))) {
      return;
    }
    toast("Conversation archived", {
      description: title,
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          lifecycle("unarchive");
        },
      },
    });
  };

  const perform = (action: RowAction): unknown => {
    switch (action) {
      case "pin":
      case "unpin": {
        return pin.mutate(
          { id, pinned: action === "pin" },
          { onError: (error) => toast.error(error.message) }
        );
      }
      case "archive": {
        if (hasSandbox) {
          setConfirming(true);
          return undefined;
        }
        return archive();
      }
      default: {
        return lifecycle(action);
      }
    }
  };

  const swipeAction = (action: RowAction): SwipeAction => ({
    key: action,
    label: ROW_ACTION_LABEL[action],
    icon: ICON[action],
    tone: TONE[action],
    // Only an Archive that is not asked about removes the row; it slides away as it goes.
    dismiss: action === "archive" && !hasSandbox,
    run: () => perform(action),
  });

  return (
    <>
      <SwipeRow
        leading={[swipeAction(leading)]}
        trailing={trailing.map(swipeAction)}
        onSwipeStart={() => setMenuOpen(false)}
      >
        <div
          className="group/row relative"
          // A right-click, a long press on Android, or the keyboard's context-menu key on the focused link.
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
          }}
        >
          {children}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            {/* Shown on hover, on keyboard focus and while open; always on a touch screen, where iOS has no long press. */}
            <span
              className={cn(
                "bg-muted absolute top-1/2 right-1 -translate-y-1/2 rounded-md opacity-0 group-hover/row:opacity-100 group-has-focus-visible/row:opacity-100 pointer-coarse:bg-transparent pointer-coarse:opacity-100",
                menuOpen && "opacity-100"
              )}
            >
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${title}`}
                  />
                }
              >
                <Ellipsis aria-hidden />
              </DropdownMenuTrigger>
            </span>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => perform(leading)}>
                <LeadingIcon aria-hidden />
                {ROW_ACTION_LABEL[leading]}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {trailing.map((action) => {
                const Icon = ICON[action];
                return (
                  <DropdownMenuItem
                    key={action}
                    variant={action === "archive" ? "destructive" : "default"}
                    onClick={() => perform(action)}
                  >
                    <Icon aria-hidden />
                    {action === "archive" && hasSandbox
                      ? "Archive…"
                      : ROW_ACTION_LABEL[action]}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SwipeRow>
      <ArchiveDialog
        hasSandbox={hasSandbox}
        open={confirming}
        onOpenChange={setConfirming}
        pending={act.isPending}
        onConfirm={async () => {
          if (await lifecycle("archive")) {
            setConfirming(false);
          }
        }}
      />
    </>
  );
};
