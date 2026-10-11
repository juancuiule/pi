"use client";

import type { ConversationSummary } from "effect-pi/api";

import { Button } from "@/components/ui/button";
import type { ConversationState } from "@/lib/conversation-state";
import { totalUsage } from "@/lib/conversation-state";
import { useEndConversation, useInfo } from "@/lib/queries";

import { SandboxBadge } from "./sandbox-badge";

export const ConversationHeader = ({
  conversation,
  state,
  onEnded,
}: {
  conversation: ConversationSummary;
  state: ConversationState;
  onEnded: () => void;
}) => {
  const { data: info } = useInfo();
  const end = useEndConversation();
  const { tokens, cost } = totalUsage(state.usage);

  const onEnd = () => {
    // oxlint-disable-next-line no-alert -- a native confirm is the intended guard for this destructive action
    if (window.confirm("End this conversation and remove its sandbox?")) {
      end.mutate(conversation.id);
      onEnded();
    }
  };

  return (
    <header className="flex items-center gap-3 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="truncate text-sm font-medium">{conversation.title}</h1>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <SandboxBadge sandbox={conversation.sandbox} />
          {conversation.sandboxId === undefined ? null : (
            <span className="max-w-32 truncate font-mono">
              {conversation.sandboxId}
            </span>
          )}
          {info === undefined ? null : <span>{info.model}</span>}
          <span>{tokens.toLocaleString()} tokens</span>
          <span>${cost.toFixed(4)}</span>
          {state.queued > 0 ? <span>{state.queued} queued</span> : null}
        </div>
      </div>
      <Button variant="destructive" size="sm" onClick={onEnd}>
        End
      </Button>
    </header>
  );
};
