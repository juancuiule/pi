"use client";

import type { AssistantMessage, EntryRecord } from "effect-pi/api";
import {
  ArrowDown,
  BookOpen,
  Brain,
  CircleAlert,
  Info,
  LoaderCircle,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { hasPendingApproval } from "@/lib/approval";
import type { ConversationState } from "@/lib/conversation-state";
import { settingsNote } from "@/lib/settings-note";
import {
  parseSkillMessage,
  skillMentionParts,
  splitSkillHints,
} from "@/lib/skill-message";
import { isNearBottom, userParts } from "@/lib/transcript";

import { Markdown } from "./markdown";
import { ToolCall } from "./tool-call";

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
}) => {
  // The person's open/close wins over the stream's default (open while thinking, closed once done).
  const [open, setOpen] = useState<boolean>();
  const line = (
    <TraceLine status={streaming ? "running" : undefined}>
      <TraceIcon>
        {streaming ? (
          <LoaderCircle className="motion-safe:animate-spin" />
        ) : (
          <Brain />
        )}
      </TraceIcon>
      <TraceTitle>{streaming ? "Thinking" : "Thought"}</TraceTitle>
    </TraceLine>
  );
  if (thinking.length === 0) {
    return line;
  }
  return (
    <TraceCollapsible open={open ?? streaming} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">
        {thinking}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** A forced skill's instructions, collapsed under its name. */
const SkillChip = ({
  skill,
  instructions,
}: {
  skill: string;
  instructions: string;
}) => (
  <Trace>
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <BookOpen />
          </TraceIcon>
          <TraceTitle>skill: {skill}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown>{instructions}</Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
);

/** A `/skill:<name>` hint in the user's text: the model was told about the skill, not made to use it. */
const SkillMention = ({ skill }: { skill: string }) => (
  <span
    title="Suggested to the model"
    className="bg-background text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 align-baseline font-mono text-xs"
  >
    <BookOpen aria-hidden className="size-3" />
    {skill}
  </span>
);

type ContentBlock = AssistantMessage["content"][number];

/** One rendered piece: text on its own, or a run of thinking/tool-call blocks sharing a Trace. */
type Segment =
  | { readonly kind: "text"; readonly index: number; readonly text: string }
  | {
      readonly kind: "steps";
      readonly items: { index: number; block: ContentBlock }[];
    };

const segmentsOf = (blocks: readonly ContentBlock[]): Segment[] => {
  const segments: Segment[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      segments.push({ kind: "text", index, text: block.text });
      continue;
    }
    if (block.type !== "thinking" && block.type !== "toolCall") {
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === "steps") {
      last.items.push({ index, block });
    } else {
      segments.push({ kind: "steps", items: [{ index, block }] });
    }
  }
  return segments;
};

/** One line inside a message's Trace: thinking or a tool call. */
const Step = ({
  block,
  streaming,
  state,
}: {
  block: ContentBlock;
  streaming: boolean;
  state: ConversationState;
}) => {
  if (block.type === "thinking") {
    return <Thinking thinking={block.thinking} streaming={streaming} />;
  }
  if (block.type === "toolCall") {
    return <ToolCall call={block} state={state} />;
  }
  return null;
};

const AssistantBlocks = ({
  message,
  state,
  caret,
}: {
  message: AssistantMessage;
  state: ConversationState;
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
      {segmentsOf(message.content).map((segment) =>
        segment.kind === "text" ? (
          <div key={`t${segment.index}`}>
            <Markdown>{segment.text}</Markdown>
            {caret && segment.index === lastTextIndex ? <Caret /> : null}
          </div>
        ) : (
          <Trace key={`s${segment.items[0]?.index ?? 0}`}>
            {segment.items.map(({ index, block }) => (
              <Step
                // oxlint-disable-next-line react/no-array-index-key -- thinking blocks have no id; the list only grows
                key={block.type === "toolCall" ? block.id : index}
                block={block}
                streaming={caret === true && index === lastIndex}
                state={state}
              />
            ))}
          </Trace>
        )
      )}
    </div>
  );
};

const Entry = ({
  entry,
  state,
}: {
  entry: EntryRecord;
  state: ConversationState;
}) => {
  const message = entry.model?.[0];
  const note =
    entry.kind === "app.settings" ? settingsNote(entry.data) : undefined;
  if (note !== undefined) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <SlidersHorizontal aria-hidden className="size-3.5" />
        {note}
      </p>
    );
  }
  if (message === undefined) {
    return (
      <Trace>
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <Info />
              </TraceIcon>
              <TraceTitle>{entry.kind}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <CodeBlock size="sm">
              <CodeBlockContent wrap className="max-h-64">
                {JSON.stringify(entry.data, null, 2)}
              </CodeBlockContent>
            </CodeBlock>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    );
  }
  switch (message.role) {
    case "user": {
      const parsed = userParts(message);
      const { text, hinted } = splitSkillHints(parsed.text);
      const { images } = parsed;
      const skill = parseSkillMessage(text);
      const shown = skill === undefined ? text : skill.request;
      return (
        <div className="bg-muted text-foreground ml-auto flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5">
          {skill === undefined ? null : (
            <SkillChip skill={skill.skill} instructions={skill.instructions} />
          )}
          {shown === "" ? null : (
            <p className="text-prose break-words whitespace-pre-wrap">
              {skillMentionParts(shown, hinted).map((part, index) =>
                part.kind === "text" ? (
                  part.text
                ) : (
                  <SkillMention
                    // oxlint-disable-next-line no-array-index-key -- parts have no identity beyond their order
                    key={index}
                    skill={part.skill}
                  />
                )
              )}
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
      return <AssistantBlocks message={message} state={state} />;
    }
    default: {
      return null;
    }
  }
};

/** The transcript's trailing activity line: "Resuming…" while a paused Conversation gets a Seat, else "Working…". */
const StatusLine = ({
  state,
  resuming,
}: {
  state: ConversationState;
  resuming: boolean;
}) => {
  const working =
    state.running &&
    state.streaming === undefined &&
    !hasPendingApproval(state);
  if (!resuming && !working) {
    return null;
  }
  return (
    <div aria-live="polite">
      <Trace>
        <TraceLine status="running">
          <TraceIcon>
            <LoaderCircle className="motion-safe:animate-spin" />
          </TraceIcon>
          <TraceTitle>{resuming ? "Resuming…" : "Working…"}</TraceTitle>
        </TraceLine>
      </Trace>
    </div>
  );
};

const Body = ({
  state,
  resuming,
}: {
  state: ConversationState;
  resuming: boolean;
}) => (
  <>
    {state.entries.map((entry) => (
      <Entry key={entry.id} entry={entry} state={state} />
    ))}
    {state.streaming === undefined ? null : (
      <AssistantBlocks message={state.streaming} state={state} caret />
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
    <StatusLine state={state} resuming={resuming} />
  </>
);

export const Transcript = ({
  state,
  resuming = false,
}: {
  state: ConversationState;
  /** A resume is in flight; the run's "Working…" line reads "Resuming…" instead. */
  resuming?: boolean;
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
          <Body state={state} resuming={resuming} />
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
