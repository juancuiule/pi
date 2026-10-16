"use client";

import type { AssistantMessage, EntryRecord, HistoryPage } from "effect-pi/api";
import {
  ArrowDown,
  BookOpen,
  Brain,
  CircleAlert,
  FoldVertical,
  History,
  Info,
  LoaderCircle,
  RotateCcw,
  SeparatorHorizontal,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { runApi } from "@/lib/api";
import { hasPendingApproval } from "@/lib/approval";
import { splitAttachments } from "@/lib/attachments";
import { boundaryNote } from "@/lib/boundary-note";
import type { BoundaryNote } from "@/lib/boundary-note";
import type { ConversationState, PendingInput } from "@/lib/conversation-state";
import { settingsNote } from "@/lib/settings-note";
import {
  parseSkillMessage,
  skillMentionParts,
  splitSkillHints,
} from "@/lib/skill-message";
import { useConversationStore } from "@/lib/store";
import { isNearBottom, userParts } from "@/lib/transcript";
import { unansweredNote } from "@/lib/unanswered-note";

import { SentChip } from "./attachment-chip";
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

const segmentsOf = (
  blocks: readonly ContentBlock[],
  showThinking: boolean
): Segment[] => {
  const segments: Segment[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      segments.push({ kind: "text", index, text: block.text });
      continue;
    }
    if (
      (block.type !== "thinking" && block.type !== "toolCall") ||
      (!showThinking && block.type === "thinking")
    ) {
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
  showThinking,
}: {
  message: AssistantMessage;
  state: ConversationState;
  caret?: boolean;
  showThinking: boolean;
}) => {
  let lastTextIndex = -1;
  for (const [index, block] of message.content.entries()) {
    if (block.type === "text") {
      lastTextIndex = index;
    }
  }
  const lastIndex = message.content.length - 1;
  const segments = segmentsOf(message.content, showThinking);
  if (segments.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3">
      {segments.map((segment) =>
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

const BOUNDARY_ICON: Record<BoundaryNote["kind"], typeof FoldVertical> = {
  compaction: FoldVertical,
  reset: RotateCcw,
  boundary: SeparatorHorizontal,
};

/** A head marker's muted row: its boundary title, with the summary or handoff text under the fold. */
const BoundaryRow = ({ note }: { note: BoundaryNote }) => {
  const Icon = BOUNDARY_ICON[note.kind];
  const line = (
    <TraceLine>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>{note.title}</TraceTitle>
    </TraceLine>
  );
  if (note.body === "") {
    return <Trace>{line}</Trace>;
  }
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Markdown>{note.body}</Markdown>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};

const Entry = ({
  entry,
  state,
  showThinking,
  conversation,
}: {
  entry: EntryRecord;
  state: ConversationState;
  showThinking: boolean;
  /** For the attachments' download links; unset while a create is in flight. */
  conversation?: number;
}) => {
  // A head marker carries a user-role message (the summary or handoff); it is a boundary, not a sent message.
  const boundary = boundaryNote(entry);
  if (boundary !== undefined) {
    return <BoundaryRow note={boundary} />;
  }
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
      // Attachment blocks come last, after any skill hints.
      const files = splitAttachments(parsed.text);
      const { text, hinted } = splitSkillHints(files.text);
      // A message's images are its attached images, already shown as chips that open them.
      const images = files.attachments.length > 0 ? [] : parsed.images;
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
          {files.attachments.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5">
              {files.attachments.map((attachment) => (
                <SentChip
                  key={attachment.id}
                  attachment={attachment}
                  conversation={conversation}
                />
              ))}
            </div>
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
          showThinking={showThinking}
        />
      );
    }
    default: {
      return null;
    }
  }
};

/**
 * A message on its way: the bubble shows right away, marked "Sending…" until the server confirms its submission;
 * the real entry then replaces it, so it is never in the transcript twice. `conversation` is unset while a new
 * Conversation's create is still in flight.
 */
export const PendingMessage = ({
  pending,
  conversation,
}: {
  pending: PendingInput;
  conversation?: number;
}) => (
  <div className="bg-muted text-foreground ml-auto flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5">
    {pending.prompt === "" ? null : (
      <p className="text-prose break-words whitespace-pre-wrap">
        {pending.prompt}
      </p>
    )}
    {pending.attachments.length === 0 ? null : (
      <div className="flex flex-wrap gap-1.5">
        {pending.attachments.map((attachment) => (
          <SentChip
            key={attachment.id}
            attachment={attachment}
            conversation={conversation}
          />
        ))}
      </div>
    )}
    {pending.submission === undefined ? (
      <span className="text-muted-foreground self-end text-xs">Sending…</span>
    ) : null}
  </div>
);

/** The transcript's trailing activity line: "Resuming…" while a paused Conversation gets a Seat, else "Working…". */
const StatusLine = ({
  state,
  resuming,
  showThinking,
}: {
  state: ConversationState;
  resuming: boolean;
  showThinking: boolean;
}) => {
  // A streaming message that renders nothing (every block is hidden thinking) still needs the activity line.
  const streamingHidden =
    !showThinking &&
    state.streaming !== undefined &&
    state.streaming.content.every((block) => block.type === "thinking");
  const working =
    state.running &&
    (state.streaming === undefined || streamingHidden) &&
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

const Failure = ({ children }: { children: string }) => (
  <p
    role="alert"
    className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border p-3 text-sm"
  >
    <CircleAlert className="size-4 shrink-0" />
    {children}
  </p>
);

/** An entry and, under it, the "not answered" note its run may have left. */
const EntryItem = ({
  entry,
  state,
  showThinking,
  conversation,
}: {
  entry: EntryRecord;
  state: ConversationState;
  showThinking: boolean;
  conversation?: number;
}) => {
  const unanswered = state.unanswered[entry.id];
  const note =
    unanswered === undefined ? undefined : unansweredNote(unanswered);
  return (
    <>
      <Entry
        entry={entry}
        state={state}
        showThinking={showThinking}
        conversation={conversation}
      />
      {note === undefined ? null : <Failure>{note}</Failure>}
    </>
  );
};

/**
 * Fetch one page of hidden history: the newest page when `before` is unset, deeper ones with the oldest held
 * entry's id. A failure only clears the spinner, so the gate stays for a retry.
 */
const showEarlier = async (
  conversation: number,
  before: number | undefined
) => {
  const { addEarlierPage, setEarlierLoading } = useConversationStore.getState();
  setEarlierLoading(conversation, true);
  try {
    const page = await runApi((c) =>
      c.conversations.history({
        params: { id: conversation },
        query: before === undefined ? {} : { before },
      })
    );
    // The endpoint's entries are storage records, typed for clients as `HistoryPage`.
    addEarlierPage(conversation, page as HistoryPage);
  } catch (error) {
    setEarlierLoading(conversation, false);
    toast.error(
      error instanceof Error
        ? error.message
        : "Could not load the earlier entries."
    );
  }
};

/** Hidden history at the top of the transcript: fetched pages in order, behind a "Show earlier entries" gate. */
const Earlier = ({
  state,
  showThinking,
  conversation,
}: {
  state: ConversationState;
  showThinking: boolean;
  conversation?: number;
}) => {
  const { entries, hasMore, loading } = state.earlier;
  if (entries.length === 0 && !hasMore && !loading) {
    return null;
  }
  return (
    <>
      {hasMore || loading ? (
        <button
          type="button"
          disabled={loading || conversation === undefined}
          onClick={() => {
            if (conversation !== undefined) {
              void showEarlier(conversation, state.earlier.frontier);
            }
          }}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mx-auto flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-3 disabled:opacity-60"
        >
          {loading ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : (
            <History aria-hidden className="size-3.5" />
          )}
          {loading ? "Loading earlier entries…" : "Show earlier entries"}
        </button>
      ) : null}
      {entries.map((entry) => (
        <EntryItem
          key={entry.id}
          entry={entry}
          state={state}
          showThinking={showThinking}
          conversation={conversation}
        />
      ))}
    </>
  );
};

const Body = ({
  state,
  resuming,
  showThinking,
  conversation,
}: {
  state: ConversationState;
  resuming: boolean;
  showThinking: boolean;
  conversation?: number;
}) => (
  <>
    <Earlier
      state={state}
      showThinking={showThinking}
      conversation={conversation}
    />
    {state.entries.map((entry) => (
      <EntryItem
        key={entry.id}
        entry={entry}
        state={state}
        showThinking={showThinking}
        conversation={conversation}
      />
    ))}
    {state.streaming === undefined ? null : (
      <AssistantBlocks
        message={state.streaming}
        state={state}
        caret
        showThinking={showThinking}
      />
    )}
    {state.pending.map((pending) => (
      <PendingMessage
        key={pending.requestId}
        pending={pending}
        conversation={conversation}
      />
    ))}
    {state.failures.map((failure) => (
      <Failure key={failure}>{failure}</Failure>
    ))}
    <StatusLine state={state} resuming={resuming} showThinking={showThinking} />
  </>
);

export const Transcript = ({
  state,
  conversation,
  resuming = false,
  showThinking = true,
}: {
  state: ConversationState;
  /** For the attachments' links; unset on the new-conversation screen while its create is in flight. */
  conversation?: number;
  /** A resume is in flight; the run's "Working…" line reads "Resuming…" instead. */
  resuming?: boolean;
  /** The header's per-conversation switch: false drops thinking blocks, keeping text and tool calls. */
  showThinking?: boolean;
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
          <Body
            state={state}
            resuming={resuming}
            showThinking={showThinking}
            conversation={conversation}
          />
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
