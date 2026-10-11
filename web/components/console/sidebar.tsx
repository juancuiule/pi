"use client";

import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConversations } from "@/lib/queries";
import { cn } from "@/lib/utils";

import { SandboxBadge } from "./sandbox-badge";

export const Sidebar = ({
  selectedId,
  onSelect,
  onNew,
}: {
  selectedId: number | undefined;
  onSelect: (id: number) => void;
  onNew: () => void;
}) => {
  const { data } = useConversations();
  const conversations = [...(data ?? [])].toSorted(
    (a, b) => b.createdAt - a.createdAt
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Button variant="outline" onClick={onNew}>
        <PlusIcon />
        New conversation
      </Button>
      <ScrollArea className="min-h-0 flex-1">
        {conversations.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">
            No conversations yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={
                    conversation.id === selectedId ? "true" : undefined
                  }
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    "hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    conversation.id === selectedId && "bg-muted"
                  )}
                >
                  <output
                    aria-label={conversation.status}
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      conversation.status === "running"
                        ? "bg-success animate-pulse"
                        : "bg-muted-foreground/50"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {conversation.title}
                  </span>
                  <SandboxBadge sandbox={conversation.sandbox} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
};
