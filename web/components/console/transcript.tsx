"use client";

import type { AssistantMessage, EntryRecord } from "effect-pi/api";
import { useEffect, useRef } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ConversationState } from "@/lib/conversation-state";
import { isNearBottom, userParts } from "@/lib/transcript";

import { ToolCall } from "./tool-call";

const AssistantBlocks = ({
  message,
  state,
  caret,
}: {
  message: AssistantMessage;
  state: ConversationState;
  caret?: boolean;
}) => (
  <div className="flex flex-col gap-2">
    {message.content.map((block, index) => {
      const last = index === message.content.length - 1;
      switch (block.type) {
        case "text": {
          return (
            // oxlint-disable-next-line react/no-array-index-key -- blocks have no id; the list only grows
            <p key={index} className="whitespace-pre-wrap">
              {block.text}
              {caret && last ? (
                <span className="ml-0.5 animate-pulse">▍</span>
              ) : null}
            </p>
          );
        }
        case "thinking": {
          return (
            // oxlint-disable-next-line react/no-array-index-key -- blocks have no id; the list only grows
            <Collapsible key={index}>
              <div className="text-muted-foreground text-xs">
                <CollapsibleTrigger>Thinking</CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                  {block.thinking}
                </p>
              </CollapsibleContent>
            </Collapsible>
          );
        }
        case "toolCall": {
          return <ToolCall key={block.id} call={block} state={state} />;
        }
        default: {
          return null;
        }
      }
    })}
  </div>
);

const Entry = ({
  entry,
  state,
}: {
  entry: EntryRecord;
  state: ConversationState;
}) => {
  const message = entry.model?.[0];
  if (message === undefined) {
    return (
      <details className="text-muted-foreground text-xs">
        <summary>{entry.kind}</summary>
        <pre className="overflow-x-auto">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      </details>
    );
  }
  switch (message.role) {
    case "user": {
      const { text, images } = userParts(message);
      return (
        <div className="bg-primary text-primary-foreground ml-auto flex max-w-[80%] flex-col gap-2 rounded-lg px-3 py-2 text-sm">
          {text === "" ? null : <p className="whitespace-pre-wrap">{text}</p>}
          {images.map((image) => (
            // oxlint-disable-next-line next/no-img-element -- inline data URL, nothing for next/image to optimize
            <img
              key={image.src}
              src={image.src}
              alt="Attached"
              className="max-w-full rounded"
            />
          ))}
        </div>
      );
    }
    case "assistant": {
      return <AssistantBlocks message={message} state={state} />;
    }
    default: {
      return null;
    }
  }
};

export const Transcript = ({
  state,
  ended = false,
}: {
  state: ConversationState;
  ended?: boolean;
}) => {
  const viewport = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current?.querySelector<HTMLDivElement>(
      "[data-slot=scroll-area-viewport]"
    );
    viewport.current = el ?? null;
    if (el === null || el === undefined) {
      return;
    }
    const onScroll = () => {
      pinned.current = isNearBottom(el);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = viewport.current;
    if (el !== null && pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  return (
    <ScrollArea ref={root} className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-4">
        {state.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} state={state} />
        ))}
        {state.streaming === undefined ? null : (
          <AssistantBlocks message={state.streaming} state={state} caret />
        )}
        {state.failures.map((failure) => (
          <p key={failure} role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        ))}
        {state.running && state.streaming === undefined ? (
          <p className="text-muted-foreground animate-pulse text-sm">
            Working…
          </p>
        ) : null}
        {ended ? (
          <p className="bg-muted rounded-md px-3 py-2 text-center text-sm">
            This conversation has ended.
          </p>
        ) : null}
      </div>
    </ScrollArea>
  );
};
