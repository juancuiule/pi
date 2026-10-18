"use client";

import type { ConversationSummary } from "effect-pi/api";
import {
  Brain,
  Download,
  LoaderCircle,
  Menu,
  PanelRight,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useRef, useState } from "react";
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
import {
  useConversationAction,
  useGenerateTitle,
  useInfo,
  useRenameConversation,
} from "@/lib/queries";
import type { ConversationAction } from "@/lib/queries";
import {
  useConversationStore,
  useResuming,
  useThinkingHidden,
} from "@/lib/store";

import { useOpenMenu } from "./console-shell";
import { ConversationActions } from "./conversation-actions";
import { ConversationSettings } from "./conversation-settings";
import { ResumingNotice } from "./resuming-notice";
import { SandboxBadge } from "./sandbox-badge";
import { WaitingNotice } from "./waiting-notice";

const ConversationTitle = ({
  conversation,
}: {
  conversation: ConversationSummary;
}) => {
  const rename = useRenameConversation(conversation.id);
  const generateTitle = useGenerateTitle(conversation.id);
  const { data: info } = useInfo();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Escape sets this before the input unmounts so its blur can't commit.
  const cancelled = useRef(false);

  const noModel = info?.titleGeneration === false;
  const regenerateLabel = noModel
    ? "Regenerate title — no model configured"
    : "Regenerate title";

  const startEditing = () => {
    cancelled.current = false;
    setDraft(conversation.title);
    setEditing(true);
  };

  const commit = () => {
    // Disabling the input while a rename is in flight can fire blur; a pending one must not commit again.
    if (rename.isPending) {
      return;
    }
    const title = draft.trim();
    if (title === "" || title === conversation.title) {
      setEditing(false);
      return;
    }
    rename.mutate(
      { title },
      {
        onSuccess: () => setEditing(false),
        onError: (error) => toast.error(error.message),
      }
    );
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 flex-1 text-sm font-medium">
        {editing ? (
          <input
            type="text"
            value={draft}
            aria-label="Conversation title"
            autoFocus
            disabled={rename.isPending}
            maxLength={200}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancelled.current = true;
                setEditing(false);
              } else if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            onBlur={() => {
              if (!cancelled.current) {
                commit();
              }
            }}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-6 w-full min-w-0 rounded-md border px-1.5 text-sm font-medium outline-none focus-visible:ring-3"
          />
        ) : (
          <button
            type="button"
            title={conversation.title}
            onClick={startEditing}
            className="focus-visible:ring-ring/50 block w-full truncate rounded-sm text-left outline-none focus-visible:ring-2"
          >
            {conversation.title}
          </button>
        )}
      </h1>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={regenerateLabel}
              disabled={noModel || generateTitle.isPending}
              onClick={() =>
                generateTitle.mutate(undefined, {
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {generateTitle.isPending ? (
                <LoaderCircle
                  aria-hidden
                  className="motion-safe:animate-spin"
                />
              ) : (
                <Sparkles />
              )}
            </Button>
          }
        />
        <TooltipContent>
          {noModel ? "No model configured" : "Regenerate title"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const ConversationHeader = ({
  conversation,
  state,
  sidePanel,
}: {
  conversation: ConversationSummary;
  state: ConversationState;
  /** Present when a sandbox side panel can be shown. */
  sidePanel?: {
    label: string;
    collapsed: boolean;
    toggle: () => void;
  };
}) => {
  const openMenu = useOpenMenu();
  const act = useConversationAction();
  const resuming = useResuming(conversation);
  const thinkingHidden = useThinkingHidden(conversation.id);
  const toggleThinking = useConversationStore((store) => store.toggleThinking);
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
          onClick={openMenu}
        >
          <Menu />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ConversationTitle conversation={conversation} />
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={thinkingHidden ? "ghost" : "secondary"}
                size="icon-sm"
                aria-label={
                  thinkingHidden ? "Show thinking steps" : "Hide thinking steps"
                }
                aria-pressed={!thinkingHidden}
                onClick={() => toggleThinking(conversation.id)}
              >
                <Brain />
              </Button>
            }
          />
          <TooltipContent>
            {thinkingHidden ? "Show thinking steps" : "Hide thinking steps"}
          </TooltipContent>
        </Tooltip>
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
        <ConversationSettings conversationId={conversation.id} />
        <ConversationActions conversation={conversation} />
      </header>
      <WaitingNotice conversation={conversation} />
      <ResumingNotice conversation={conversation} />
    </>
  );
};
