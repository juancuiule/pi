"use client";

import type { ConversationSummary } from "effect-pi/api";
import {
  Download,
  LoaderCircle,
  Menu,
  PanelRight,
  ShieldAlert,
} from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiError } from "@/lib/api";
import { hasPendingApproval } from "@/lib/approval";
import type { ConversationState } from "@/lib/conversation-state";
import { totalUsage } from "@/lib/conversation-state";
import { exportSlug, toJsonl, toMarkdown } from "@/lib/export";
import { formatCost, formatTokens } from "@/lib/format";
import { useEndConversation } from "@/lib/queries";

import { SandboxBadge } from "./sandbox-badge";

export const ConversationHeader = ({
  conversation,
  state,
  onEnded,
  onMenu,
  sidePanel,
}: {
  conversation: ConversationSummary;
  state: ConversationState;
  onEnded: () => void;
  /** Opens the mobile navigation sheet. */
  onMenu: () => void;
  /** Present when a sandbox side panel can be shown. */
  sidePanel?: {
    label: string;
    collapsed: boolean;
    toggle: () => void;
  };
}) => {
  const [confirming, setConfirming] = useState(false);
  const end = useEndConversation();
  const { tokens, cost } = totalUsage(state.usage);

  const onEnd = () => {
    end.mutate(conversation.id, {
      onSuccess: () => {
        setConfirming(false);
        onEnded();
      },
      onError: (error) => {
        // Already gone on the server: nothing left to end, so leave the conversation.
        if (error.message === apiError({ _tag: "ConversationNotFound" })) {
          setConfirming(false);
          onEnded();
        }
        toast.error(error.message);
      },
    });
  };

  const hasSandbox = conversation.sandbox !== "none";
  const ended = conversation.status === "ended";

  const handleTogglePanel = () => sidePanel?.toggle();

  const download = (kind: "md" | "jsonl") => {
    const name = `${exportSlug(conversation.title, conversation.id)}.${kind}`;
    const body =
      kind === "md" ? toMarkdown(conversation, state) : toJsonl(state);
    const url = URL.createObjectURL(
      new Blob([body], {
        type: kind === "md" ? "text/markdown" : "application/jsonlines",
      })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <header className="flex items-center gap-3 border-b px-3 py-2 md:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Conversations"
        className="md:hidden"
        onClick={onMenu}
      >
        <Menu />
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1 className="truncate text-sm font-medium" title={conversation.title}>
          {conversation.title}
        </h1>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <SandboxBadge sandbox={conversation.sandbox} />
          {conversation.sandboxId === undefined ? null : (
            <span
              className="max-w-32 truncate font-mono"
              title={conversation.sandboxId}
            >
              {conversation.sandboxId}
            </span>
          )}
          <span className="tabular-nums">{formatTokens(tokens)} tokens</span>
          {cost === 0 ? null : (
            <span className="tabular-nums">{formatCost(cost)}</span>
          )}
          {state.running && !hasPendingApproval(state) ? (
            <span className="inline-flex items-center gap-1">
              <LoaderCircle
                aria-hidden
                className="size-3 motion-safe:animate-spin"
              />
              Working
            </span>
          ) : null}
          {state.queued > 0 ? (
            <span className="tabular-nums">{state.queued} queued</span>
          ) : null}
          {conversation.pendingApprovals > 0 ? (
            <span className="text-warning inline-flex items-center gap-1">
              <ShieldAlert className="size-3" aria-hidden />
              Waiting for approval
            </span>
          ) : null}
        </div>
      </div>
      {hasSandbox && sidePanel !== undefined ? (
        <Button
          variant={sidePanel.collapsed ? "ghost" : "secondary"}
          size="icon-sm"
          aria-label={`${sidePanel.collapsed ? "Show" : "Hide"} ${sidePanel.label}`}
          aria-pressed={!sidePanel.collapsed}
          onClick={handleTogglePanel}
        >
          <PanelRight />
        </Button>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Export conversation"
                  >
                    <Download />
                  </Button>
                }
              />
            }
          />
          <TooltipContent>Export conversation</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => download("md")}>
            Markdown
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => download("jsonl")}>
            JSON Lines
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {ended ? null : (
        <Button
          variant="destructive"
          size="sm"
          disabled={end.isPending}
          onClick={() => setConfirming(true)}
        >
          End
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasSandbox
                ? "The agent stops and its sandbox is removed. This can't be undone."
                : "The agent stops. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onEnd}>
              {end.isPending ? "Ending…" : "End conversation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
};
