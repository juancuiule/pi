"use client";

import { useState } from "react";
import type { ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ConversationState } from "@/lib/conversation-state";
import { useConversationEvents } from "@/lib/use-conversation-events";

type Render = (state: ConversationState) => ReactNode;

/** Subscribes to the child's events; mounted only while the card is open. */
const SubagentTranscript = ({ id, render }: { id: number; render: Render }) =>
  render(useConversationEvents(id));

export const SubagentStream = ({
  id,
  running,
  render,
}: {
  id: number;
  running: boolean;
  /** Renders the child transcript; passed in so this module need not import `Transcript` (import cycle). */
  render: Render;
}) => {
  // Each open card holds an SSE connection, and browsers allow 6 per host, so closed cards hold none.
  const [open, setOpen] = useState(running);
  return (
    <div className="px-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="text-muted-foreground text-xs">
          <CollapsibleTrigger>Subagent conversation #{id}</CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          {open ? <SubagentTranscript id={id} render={render} /> : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
