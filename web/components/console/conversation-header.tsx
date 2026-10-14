"use client";

import type { ConversationSummary } from "effect-pi/api";
import {
  Download,
  LoaderCircle,
  Menu,
  PanelRight,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

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
import { hasPendingApproval } from "@/lib/approval";
import type { ConversationState } from "@/lib/conversation-state";
import { totalUsage } from "@/lib/conversation-state";
import { exportSlug, toJsonl, toMarkdown } from "@/lib/export";
import { formatCost, formatTokens } from "@/lib/format";
import { useConversationAction } from "@/lib/queries";
import type { ConversationAction } from "@/lib/queries";
import { useResuming } from "@/lib/store";

import { ConversationActions } from "./conversation-actions";
import { ResumingNotice } from "./resuming-notice";
import { SandboxBadge } from "./sandbox-badge";
import { WaitingNotice } from "./waiting-notice";

export const ConversationHeader = ({
  conversation,
  state,
  onMenu,
  sidePanel,
}: {
  conversation: ConversationSummary;
  state: ConversationState;
  /** Opens the mobile navigation sheet. */
  onMenu: () => void;
  /** Present when a sandbox side panel can be shown. */
  sidePanel?: {
    label: string;
    collapsed: boolean;
    toggle: () => void;
  };
}) => {
  const act = useConversationAction();
  const resuming = useResuming(conversation);
  const { tokens, cost } = totalUsage(state.usage);
  const { status } = conversation;

  const run = (action: ConversationAction) => {
    act.mutate(
      { id: conversation.id, action },
      { onError: (error) => toast.error(error.message) }
    );
  };

  const hasSandbox = conversation.sandbox !== "none";

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
    <>
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
          <h1
            className="truncate text-sm font-medium"
            title={conversation.title}
          >
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
            {status === "paused" && !resuming ? <span>Paused</span> : null}
            {resuming ? (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle
                  aria-hidden
                  className="size-3 motion-safe:animate-spin"
                />
                Resuming
              </span>
            ) : null}
            {status === "archived" ? <span>Archived</span> : null}
            {conversation.pausing ? (
              <span className="inline-flex items-center gap-1">
                Pausing after this run
                <Button
                  variant="link"
                  size="xs"
                  disabled={act.isPending}
                  onClick={() => run("resume")}
                >
                  Keep running
                </Button>
              </span>
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
        <ConversationActions conversation={conversation} />
      </header>
      <WaitingNotice conversation={conversation} />
      <ResumingNotice conversation={conversation} />
    </>
  );
};
