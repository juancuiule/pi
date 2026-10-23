"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { Bot, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { waitingCalls } from "@/lib/approval";
import type { ConversationState } from "@/lib/conversation-state";
import { useConversationEvents } from "@/lib/use-conversation-events";

import { ToolCall } from "./tool-call";

type Render = (state: ConversationState) => ReactNode;

/** Subscribes to the child's events; mounted only while the panel is open. */
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
  // Each open panel holds an SSE connection, and browsers allow 6 per host, so closed panels hold none.
  const [open, setOpen] = useState(running);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="text-muted-foreground group focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2">
        <Bot aria-hidden className="size-3.5" strokeWidth={1.5} />
        Subagent #{id}
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90"
          strokeWidth={1.5}
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {open ? <SubagentTranscript id={id} render={render} /> : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
};

/**
 * A subagent's calls that wait on the person, under the line naming it. Subscribes to the child, so it is mounted
 * only while the `task` call is in flight; nothing renders while nothing waits.
 */
export const SubagentWaiting = ({ id }: { id: number }) => {
  const child = useConversationEvents(id);
  const calls = waitingCalls(child.entries, child);
  if (calls.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Bot aria-hidden className="size-3.5" strokeWidth={1.5} />
        Subagent #{id}
      </span>
      {calls.map((call) => (
        <ToolCall key={call.id} call={call} state={child} />
      ))}
    </div>
  );
};
