"use client";

// Shown under the header while a paused Conversation is being resumed: a new Seat, and a fresh Sandbox over the
// Workspace's files when its Level has one. The transcript stays readable behind it.
import type { ConversationSummary } from "effect-pi/api";
import { LoaderCircle } from "lucide-react";

import { useResuming } from "@/lib/store";

export const ResumingNotice = ({
  conversation,
}: {
  conversation: ConversationSummary;
}) => {
  const resuming = useResuming(conversation);
  if (!resuming) {
    return null;
  }
  return (
    <div
      aria-live="polite"
      className="bg-muted/50 flex items-center gap-2 border-b px-3 py-2 text-sm md:px-4"
    >
      <LoaderCircle
        aria-hidden
        className="text-muted-foreground size-4 shrink-0 motion-safe:animate-spin"
      />
      <span className="flex-1">
        {conversation.sandbox === "none"
          ? "Resuming the conversation…"
          : `Resuming the conversation — starting a fresh ${conversation.sandbox} sandbox over its workspace…`}
      </span>
    </div>
  );
};
