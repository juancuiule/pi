"use client";

import type { ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ConversationState } from "@/lib/conversation-state";
import { useConversationEvents } from "@/lib/use-conversation-events";

export const SubagentStream = ({
  id,
  running,
  render,
}: {
  id: number;
  running: boolean;
  /** Renders the child transcript; passed in so this module need not import `Transcript` (import cycle). */
  render: (state: ConversationState) => ReactNode;
}) => {
  const state = useConversationEvents(id);
  return (
    <div className="px-3">
      <Collapsible defaultOpen={running}>
        <div className="text-muted-foreground text-xs">
          <CollapsibleTrigger>Subagent conversation #{id}</CollapsibleTrigger>
        </div>
        <CollapsibleContent>{render(state)}</CollapsibleContent>
      </Collapsible>
    </div>
  );
};
