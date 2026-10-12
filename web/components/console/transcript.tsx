"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import type { AssistantMessage, EntryRecord } from "effect-pi/api";
import {
  ArrowDown,
  BookOpen,
  Brain,
  CircleAlert,
  ChevronRight,
  Info,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { hasPendingApproval } from "@/lib/approval";
import type { ConversationState, ToolRun } from "@/lib/conversation-state";
import { toolResultOf } from "@/lib/conversation-state";
import { parseSkillMessage } from "@/lib/skill-message";
import { subagentIdFor } from "@/lib/subagent";
import { isNearBottom, userParts } from "@/lib/transcript";

import { Markdown } from "./markdown";
import { SubagentStream } from "./subagent";
import { ToolCall } from "./tool-call";
import type { ToolCallBlock } from "./tool-call";

type RenderExtra = (
  call: ToolCallBlock,
  tool: ToolRun | undefined
) => ReactNode;

const Caret = () => (
  <span
    aria-hidden
    className="bg-foreground ml-0.5 inline-block h-4 w-2 translate-y-0.5 motion-safe:animate-pulse"
  />
);

const Thinking = ({
  thinking,
  streaming = false,
}: {
  thinking: string;
  /** The run's live block: show it's still going. */
  streaming?: boolean;
}) => (
  <Collapsible.Root>
    <Collapsible.Trigger className="text-muted-foreground group focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2">
      <Brain className="size-3.5" />
      <span>
        Thinking
        {streaming ? "…" : ""}
      </span>
      {streaming ? (
        <span
          aria-hidden
          className="bg-muted-foreground/40 h-1.5 w-8 rounded-full motion-safe:animate-pulse"
        />
      ) : null}
      <ChevronRight className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90" />
    </Collapsible.Trigger>
    <Collapsible.Panel>
      <p className="border-border text-muted-foreground mt-1.5 border-l-2 pl-3 text-sm whitespace-pre-wrap">
        {thinking}
      </p>
    </Collapsible.Panel>
  </Collapsible.Root>
);

/** A forced skill's instructions, collapsed under its name. */
const SkillChip = ({
  skill,
  instructions,
}: {
  skill: string;
  instructions: string;
}) => (
  <Collapsible.Root>
    <Collapsible.Trigger className="text-muted-foreground group focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-sm text-xs font-medium outline-none focus-visible:ring-2">
      <BookOpen className="size-3.5" />
      <span>skill: {skill}</span>
      <ChevronRight className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90" />
    </Collapsible.Trigger>
    <Collapsible.Panel>
      <div className="border-border mt-1.5 border-l-2 pl-3 text-sm">
        <Markdown>{instructions}</Markdown>
      </div>
    </Collapsible.Panel>
  </Collapsible.Root>
);

const AssistantBlocks = ({
  message,
  state,
  renderExtra,
  caret,
}: {
  message: AssistantMessage;
  state: ConversationState;
  renderExtra: RenderExtra;
  caret?: boolean;
}) => {
  let lastTextIndex = -1;
  for (const [index, block] of message.content.entries()) {
    if (block.type === "text") {
      lastTextIndex = index;
    }
  }
  const lastIndex = message.content.length - 1;
  return (
    <div className="flex flex-col gap-3">
      {message.content.map((block, index) => {
        const streaming = caret === true && index === lastIndex;
        switch (block.type) {
          case "text": {
            return (
              // oxlint-disable-next-line react/no-array-index-key -- blocks have no id; the list only grows
              <div key={index}>
                <Markdown>{block.text}</Markdown>
                {caret === true && index === lastTextIndex ? <Caret /> : null}
              </div>
            );
          }
          case "thinking": {
            return (
              // oxlint-disable-next-line react/no-array-index-key -- blocks have no id; the list only grows
              <Thinking
                key={index}
                thinking={block.thinking}
                streaming={streaming}
              />
            );
          }
          case "toolCall": {
            return (
              <ToolCall
                key={block.id}
                call={block}
                state={state}
                renderExtra={renderExtra}
              />
            );
          }
          default: {
            return null;
          }
        }
      })}
    </div>
  );
};

const Entry = ({
  entry,
  state,
  renderExtra,
}: {
  entry: EntryRecord;
  state: ConversationState;
  renderExtra: RenderExtra;
}) => {
  const message = entry.model?.[0];
  if (message === undefined) {
    return (
      <details className="text-muted-foreground text-xs">
        <summary className="inline-flex cursor-pointer items-center gap-1.5">
          <Info className="size-3.5" />
          {entry.kind}
        </summary>
        <pre className="mt-1 overflow-x-auto pl-5">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      </details>
    );
  }
  switch (message.role) {
    case "user": {
      const { text, images } = userParts(message);
      const skill = parseSkillMessage(text);
      const shown = skill === undefined ? text : skill.request;
      return (
        <div className="bg-muted text-foreground ml-auto flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5">
          {skill === undefined ? null : (
            <SkillChip skill={skill.skill} instructions={skill.instructions} />
          )}
          {shown === "" ? null : (
            <p className="text-prose break-words whitespace-pre-wrap">
              {shown}
            </p>
          )}
          {images.map((image) => (
            // oxlint-disable-next-line next/no-img-element -- inline data URL, nothing for next/image to optimize
            <img
              key={image.src}
              src={image.src}
              alt="Attachment"
              className="max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          ))}
        </div>
      );
    }
    case "assistant": {
      return (
        <AssistantBlocks
          message={message}
          state={state}
          renderExtra={renderExtra}
        />
      );
    }
    default: {
      return null;
    }
  }
};

const Body = ({
  state,
  renderExtra,
}: {
  state: ConversationState;
  renderExtra: RenderExtra;
}) => (
  <>
    {state.entries.map((entry) => (
      <Entry
        key={entry.id}
        entry={entry}
        state={state}
        renderExtra={renderExtra}
      />
    ))}
    {state.streaming === undefined ? null : (
      <AssistantBlocks
        message={state.streaming}
        state={state}
        renderExtra={renderExtra}
        caret
      />
    )}
    {state.failures.map((failure) => (
      <p
        key={failure}
        role="alert"
        className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border p-3 text-sm"
      >
        <CircleAlert className="size-4 shrink-0" />
        {failure}
      </p>
    ))}
    {state.running &&
    state.streaming === undefined &&
    !hasPendingApproval(state) ? (
      <p
        aria-live="polite"
        className="text-muted-foreground flex items-center gap-1.5 text-sm"
      >
        <LoaderCircle
          aria-hidden
          className="size-3.5 motion-safe:animate-spin"
        />
        Working…
      </p>
    ) : null}
  </>
);

const ScrollingTranscript = ({
  state,
  renderExtra,
}: {
  state: ConversationState;
  renderExtra: RenderExtra;
}) => {
  const viewport = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const root = useRef<HTMLDivElement | null>(null);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = root.current?.querySelector<HTMLDivElement>(
      "[data-slot=scroll-area-viewport]"
    );
    viewport.current = el ?? null;
    if (el === null || el === undefined) {
      return;
    }
    const onScroll = () => {
      const was = pinned.current;
      pinned.current = isNearBottom(el);
      if (pinned.current !== was) {
        setShowJump(!pinned.current);
      }
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

  const jump = () => {
    const el = viewport.current;
    if (el !== null) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
      pinned.current = true;
      setShowJump(false);
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      <ScrollArea ref={root} className="h-full">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          <Body state={state} renderExtra={renderExtra} />
        </div>
      </ScrollArea>
      {showJump ? (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={jump}
          className="bg-background hover:bg-muted focus-visible:ring-ring/50 absolute bottom-4 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border shadow-md transition-colors duration-150 outline-none focus-visible:ring-2"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
    </div>
  );
};

export const Transcript = ({
  state,
  nested = false,
}: {
  state: ConversationState;
  /** Inside a subagent card: no scroll area, no auto-scroll. */
  nested?: boolean;
}) => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- refers to `Transcript` itself (no-use-before-define forbids hoisting it)
  const renderExtra: RenderExtra = (call, tool) => {
    const id =
      call.name === "subagent" ? subagentIdFor(state, call.id) : undefined;
    return id === undefined ? null : (
      <SubagentStream
        id={id}
        running={
          tool?.status !== "done" && toolResultOf(state, call.id) === undefined
        }
        render={(child) => <Transcript state={child} nested />}
      />
    );
  };
  return nested ? (
    <div className="border-border flex flex-col gap-3 border-l-2 pl-4">
      <Body state={state} renderExtra={renderExtra} />
    </div>
  ) : (
    <ScrollingTranscript state={state} renderExtra={renderExtra} />
  );
};
