"use client";

import { cn } from "cn";
import type {
  AssistantMessage,
  EntryRecord,
  HistoryPage,
  QueuedInput,
} from "effect-pi/api";
import {
  ArrowDown,
  BookOpen,
  Brain,
  CircleAlert,
  Clock,
  FoldVertical,
  History,
  Info,
  ListCollapse,
  LoaderCircle,
  RotateCcw,
  SeparatorHorizontal,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
} from "@/components/ui/code-block";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceNest,
  TraceTitle,
} from "@/components/ui/trace";
import { runApi } from "@/lib/api";
import { hasPendingApproval, waitingCalls } from "@/lib/approval";
import { boundaryNote } from "@/lib/boundary-note";
import type { BoundaryNote } from "@/lib/boundary-note";
import type { ConversationState, PendingInput } from "@/lib/conversation-state";
import {
  finalResponse,
  groupSimple,
  toolResultOf,
} from "@/lib/conversation-state";
import { messageTime } from "@/lib/format";
import { useInfo, useWithdrawMessage } from "@/lib/queries";
import { settingsNote } from "@/lib/settings-note";
import { skillMentionParts } from "@/lib/skill-message";
import { useConversationStore } from "@/lib/store";
import { subagentIdFor, subagentsInFlight } from "@/lib/subagent";
import { displayParts, isNearBottom, userParts } from "@/lib/transcript";
import { unansweredNote } from "@/lib/unanswered-note";
import { useNow } from "@/lib/use-now";

import { ArtifactCard } from "./artifact-card";
import { SentChip } from "./attachment-chip";
import { FeedbackActions } from "./feedback-actions";
import { Markdown } from "./markdown";
import { SubagentStream, SubagentWaiting } from "./subagent";
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
    <BookOpen aria-hidden className="size-3" strokeWidth={1.5} />
    {skill}
  </span>
);

/** The message's timestamp, when it carries one (older entries and test fixtures may not). */
const atOf = (entry: EntryRecord): number | undefined => {
  const at = entry.model?.[0]?.timestamp;
  return typeof at === "number" && at > 0 ? at : undefined;
};

/** A message's clock time; the shared 30s clock keeps the same-day/other-day boundary right. */
const MessageTime = ({ at }: { at: number }) => {
  const now = useNow();
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className="text-muted-foreground/70 shrink-0 text-xs tabular-nums"
    >
      {messageTime(at, now)}
    </time>
  );
};

/**
 * A copy button under a message, revealed on hover/focus like the feedback controls; always shown on touch.
 * `group/msg` is the message's own hover scope (its bubble, or the assistant block).
 */
const MessageCopy = ({ value }: { value: string }) => (
  <span className="opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 pointer-coarse:opacity-100">
    <CodeBlockCopyButton
      value={value}
      aria-label="Copy message"
      title="Copy message"
    />
  </span>
);

/**
 * Under a message: its clock time, then rating (assistant entries, when the server traces) and copy, which
 * reveal on hover. The time leads the left-aligned row so it sits flush under the message instead of floating
 * past the unseen controls; under a right-aligned bubble it trails, keeping the bubble's corner. Nothing when
 * none of the three apply — a person's message before timestamps, for instance.
 */
const MessageFooter = ({
  conversation,
  entry,
  copy,
  at,
  align,
}: {
  conversation?: number;
  /** The assistant entry feedback scores on; unset for a person's message. */
  entry?: number;
  /** The text "Copy message" puts on the clipboard. */
  copy?: string;
  /** The message's timestamp, when it carries one. */
  at?: number;
  /** `end` aligns the row under a right-aligned bubble. */
  align?: "end";
}) => {
  const { data: info } = useInfo();
  const feedback =
    conversation !== undefined && entry !== undefined && info?.tracing === true;
  if (!feedback && (copy === undefined || copy === "") && at === undefined) {
    return null;
  }
  const time = at === undefined ? null : <MessageTime at={at} />;
  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-0.5 px-0.5",
        align === "end" && "justify-end"
      )}
    >
      {align === "end" ? null : time}
      {feedback && conversation !== undefined && entry !== undefined ? (
        <FeedbackActions conversation={conversation} entry={entry} />
      ) : null}
      {copy === undefined || copy === "" ? null : <MessageCopy value={copy} />}
      {align === "end" ? time : null}
    </div>
  );
};

/** The X beside a queued message: takes it back before a run picks it up. */
const WithdrawQueued = ({ onClick }: { onClick: () => void }) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Withdraw queued message"
          onClick={onClick}
        >
          <X />
        </Button>
      }
    />
    <TooltipContent>Withdraw queued message</TooltipContent>
  </Tooltip>
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

/** A `task` call's child transcript: live steps inside the call's card, subscribed while its panel is open. */
const subagentExtra = (
  call: Extract<ContentBlock, { type: "toolCall" }>,
  state: ConversationState,
  showThinking: boolean
) => {
  const id = subagentIdFor(state, call.id);
  if (id === undefined) {
    return;
  }
  const tool = state.tools[call.id];
  return (
    <SubagentStream
      id={id}
      running={
        tool?.status !== "done" && toolResultOf(state, call.id) === undefined
      }
      render={(child) => (
        // oxlint-disable-next-line no-use-before-define -- the recursion is bounded: children get no `task` tool
        <NestedTranscript
          state={child}
          conversation={id}
          showThinking={showThinking}
        />
      )}
    />
  );
};

/** One line inside a message's Trace: thinking or a tool call. */
const Step = ({
  block,
  streaming,
  state,
  showThinking,
}: {
  block: ContentBlock;
  streaming: boolean;
  state: ConversationState;
  showThinking: boolean;
}) => {
  if (block.type === "thinking") {
    return <Thinking thinking={block.thinking} streaming={streaming} />;
  }
  if (block.type === "toolCall") {
    return block.name.startsWith("artifact_") ? (
      <ArtifactCard call={block} state={state} />
    ) : (
      <ToolCall
        call={block}
        state={state}
        extra={
          block.name === "task"
            ? subagentExtra(block, state, showThinking)
            : undefined
        }
      />
    );
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
            <Markdown workspaceLinks>{segment.text}</Markdown>
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
                showThinking={showThinking}
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
        <SlidersHorizontal aria-hidden className="size-3.5" strokeWidth={1.5} />
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
      const parts = displayParts(parsed.text);
      // A message's images are its attached images, already shown as chips that open them.
      const images = parts.attachments.length > 0 ? [] : parsed.images;
      return (
        <div className="group/msg ml-auto flex max-w-[85%] flex-col">
          <div className="bg-muted text-foreground flex flex-col gap-2 rounded-2xl px-4 py-2.5">
            {parts.skill === undefined ? null : (
              <SkillChip
                skill={parts.skill.skill}
                instructions={parts.skill.instructions}
              />
            )}
            {parts.shown === "" ? null : (
              <p className="text-prose break-words whitespace-pre-wrap">
                {skillMentionParts(parts.shown, parts.hinted).map(
                  (part, index) =>
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
            {parts.attachments.length === 0 ? null : (
              <div className="flex flex-wrap gap-1.5">
                {parts.attachments.map((attachment) => (
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
          <MessageFooter copy={parts.shown} at={atOf(entry)} align="end" />
        </div>
      );
    }
    case "assistant": {
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n\n");
      return (
        <div className="group/msg group/feedback">
          <AssistantBlocks
            message={message}
            state={state}
            showThinking={showThinking}
          />
          <MessageFooter
            conversation={conversation}
            entry={entry.id}
            copy={text}
            at={atOf(entry)}
          />
        </div>
      );
    }
    default: {
      return null;
    }
  }
};

/** A pending bubble's corner mark: "Sending…" until admitted, "Queued" (with a withdraw) while it waits. */
const SendStatus = ({
  pending,
  queued,
  onWithdraw,
}: {
  pending: PendingInput;
  queued: boolean;
  onWithdraw?: () => void;
}) => {
  if (pending.submission === undefined) {
    return (
      <span className="text-muted-foreground self-end text-xs">Sending…</span>
    );
  }
  if (!queued) {
    return null;
  }
  return (
    <span className="flex items-center gap-1 self-end">
      <span className="text-muted-foreground text-xs">Queued</span>
      {onWithdraw === undefined ? null : (
        <WithdrawQueued onClick={onWithdraw} />
      )}
    </span>
  );
};

/**
 * A message on its way: the bubble shows right away, marked "Sending…" until the server confirms its submission;
 * the real entry then replaces it, so it is never in the transcript twice. `conversation` is unset while a new
 * Conversation's create is still in flight.
 */
export const PendingMessage = ({
  pending,
  conversation,
  onWithdraw,
}: {
  pending: PendingInput;
  conversation?: number;
  /** Offered while the submission waits in the inbox: withdraws it. */
  onWithdraw?: (submission: number, pending: PendingInput) => void;
}) => {
  const { submission } = pending;
  // Still in the inbox — neither placed nor settled — while the send is confirmed and no entry replaced it.
  const queued = submission !== undefined && pending.entry === undefined;
  return (
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
      <SendStatus
        pending={pending}
        queued={queued}
        onWithdraw={
          submission === undefined || onWithdraw === undefined
            ? undefined
            : () => onWithdraw(submission, pending)
        }
      />
    </div>
  );
};

/**
 * A queued send carried by the inbox's items — one this client did not send (its own show as "Queued" pending
 * bubbles). A write item has no text, so it renders as a muted line instead of a bubble.
 */
const QueuedMessage = ({
  item,
  conversation,
  onWithdraw,
}: {
  item: QueuedInput;
  conversation?: number;
  onWithdraw?: (submission: number) => void;
}) => {
  if (item.mode === "write") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Clock aria-hidden className="size-3.5" strokeWidth={1.5} />
        Queued: {item.kind ?? "a change"}
      </p>
    );
  }
  const parts = displayParts(item.text);
  return (
    <div className="bg-muted text-foreground ml-auto flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5">
      {parts.skill === undefined ? null : (
        <SkillChip
          skill={parts.skill.skill}
          instructions={parts.skill.instructions}
        />
      )}
      {parts.shown === "" ? null : (
        <p className="text-prose break-words whitespace-pre-wrap">
          {skillMentionParts(parts.shown, parts.hinted).map((part, index) =>
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
      {parts.attachments.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {parts.attachments.map((attachment) => (
            <SentChip
              key={attachment.id}
              attachment={attachment}
              conversation={conversation}
            />
          ))}
        </div>
      )}
      <span className="flex items-center gap-1 self-end">
        <span className="text-muted-foreground text-xs">Queued</span>
        {onWithdraw === undefined ? null : (
          <WithdrawQueued onClick={() => onWithdraw(item.id)} />
        )}
      </span>
    </div>
  );
};

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
 * The run's calls that wait on the person, lifted under a closed "Details" on its nesting line: its own, then each
 * in-flight subagent's. The line hides itself when nothing renders inside.
 */
const Waiting = ({
  entries,
  state,
}: {
  entries: readonly EntryRecord[];
  state: ConversationState;
}) => (
  <TraceNest className="mt-0 has-[>:empty]:hidden">
    <div className="flex flex-col gap-2">
      {waitingCalls(entries, state).map((call) => (
        <ToolCall key={call.id} call={call} state={state} />
      ))}
      {subagentsInFlight(entries, state).map((id) => (
        <SubagentWaiting key={id} id={id} />
      ))}
    </div>
  </TraceNest>
);

/**
 * One run in the simple view: its steps fold under "Details", its closing answer stays outside. A run that was
 * only its answer — a single all-text entry — has nothing to fold, so it renders whole.
 */
const SimpleRun = ({
  entries,
  state,
  showThinking,
  conversation,
}: {
  entries: readonly EntryRecord[];
  state: ConversationState;
  showThinking: boolean;
  conversation?: number;
}) => {
  const [open, setOpen] = useState(false);
  const final = finalResponse(entries);
  const [only] = entries;
  if (
    entries.length === 1 &&
    only !== undefined &&
    final !== undefined &&
    only.model?.[0]?.role === "assistant" &&
    only.model[0].content.every((block) => block.type === "text")
  ) {
    return (
      <EntryItem
        entry={only}
        state={state}
        showThinking={showThinking}
        conversation={conversation}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {entries.length === 0 ? null : (
        <Trace>
          <TraceCollapsible open={open} onOpenChange={setOpen}>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon>
                  <ListCollapse />
                </TraceIcon>
                <TraceTitle>Details</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <div className="flex flex-col gap-4">
                {entries.map((entry) => (
                  <EntryItem
                    key={entry.id}
                    entry={entry}
                    state={state}
                    showThinking={showThinking}
                    conversation={conversation}
                  />
                ))}
              </div>
            </TraceCollapsibleContent>
          </TraceCollapsible>
          {/* Lifted only while closed: an open "Details" shows the card in place, so it is never mounted twice. */}
          {open ? null : <Waiting entries={entries} state={state} />}
        </Trace>
      )}
      {final === undefined ? null : (
        <div className="group/msg group/feedback">
          <Markdown workspaceLinks>{final.text}</Markdown>
          <MessageFooter
            conversation={conversation}
            entry={final.entry.id}
            copy={final.text}
            at={atOf(final.entry)}
          />
        </div>
      )}
    </div>
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
        : "Couldn't load earlier entries. Try again.",
      { duration: Infinity }
    );
  }
};

/** An entry, or — in the simple view — a person message or one folded run. */
const TranscriptItem = ({
  item,
  state,
  showThinking,
  conversation,
}: {
  item: ReturnType<typeof groupSimple>[number];
  state: ConversationState;
  showThinking: boolean;
  conversation?: number;
}) =>
  item.kind === "message" ? (
    <EntryItem
      entry={item.entry}
      state={state}
      showThinking={showThinking}
      conversation={conversation}
    />
  ) : (
    <SimpleRun
      entries={item.entries}
      state={state}
      showThinking={showThinking}
      conversation={conversation}
    />
  );

/** Hidden history at the top of the transcript: fetched pages in order, behind a "Show earlier entries" gate. */
const Earlier = ({
  state,
  showThinking,
  simple,
  conversation,
}: {
  state: ConversationState;
  showThinking: boolean;
  /** The simple view groups the fetched pages into messages and folded runs too. */
  simple: boolean;
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
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mx-auto flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-3 disabled:opacity-60"
        >
          {loading ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 motion-safe:animate-spin"
              strokeWidth={1.5}
            />
          ) : (
            <History aria-hidden className="size-3.5" strokeWidth={1.5} />
          )}
          {loading ? "Loading earlier entries…" : "Show earlier entries"}
        </button>
      ) : null}
      {simple
        ? groupSimple(entries).map((item, index) => (
            <TranscriptItem
              key={item.kind === "message" ? item.entry.id : `run-${index}`}
              item={item}
              state={state}
              showThinking={showThinking}
              conversation={conversation}
            />
          ))
        : entries.map((entry) => (
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
  simple,
  conversation,
}: {
  state: ConversationState;
  resuming: boolean;
  showThinking: boolean;
  /** The simple view: the person's messages and each run's final answer, steps folded under "Details". */
  simple: boolean;
  conversation?: number;
}) => {
  const withdraw = useWithdrawMessage(conversation);
  const takeBack = (submission: number, pending?: PendingInput) => {
    // The settled event replaces the queue bubble; drop the local pending bubble with it so it does not read
    // "Not sent" in the gap.
    if (pending !== undefined && conversation !== undefined) {
      useConversationStore
        .getState()
        .dropPending(conversation, pending.requestId);
    }
    withdraw.mutate(submission, {
      onError: (error) => {
        if (pending !== undefined && conversation !== undefined) {
          useConversationStore.getState().addPending(conversation, pending);
        }
        toast.error(error.message, { duration: Infinity });
      },
      onSuccess: ({ outcome }) => {
        // "placed"/"settled" mean the run got the message after all — its entry lands with the next events.
        if (outcome !== "withdrawn") {
          toast("The run already picked it up.");
        }
      },
    });
  };
  // Queued sends this client did not make: its own already show as "Queued" pending bubbles.
  const queued = state.queue.filter(
    (item) => !state.pending.some((pending) => pending.submission === item.id)
  );
  return (
    <>
      <Earlier
        state={state}
        showThinking={showThinking}
        simple={simple}
        conversation={conversation}
      />
      {simple
        ? groupSimple(state.entries).map((item, index) => (
            <TranscriptItem
              key={item.kind === "message" ? item.entry.id : `run-${index}`}
              item={item}
              state={state}
              showThinking={showThinking}
              conversation={conversation}
            />
          ))
        : state.entries.map((entry) => (
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
          onWithdraw={conversation === undefined ? undefined : takeBack}
        />
      ))}
      {queued.map((item) => (
        <QueuedMessage
          key={item.id}
          item={item}
          conversation={conversation}
          onWithdraw={conversation === undefined ? undefined : takeBack}
        />
      ))}
      {state.failures.map((failure) => (
        <Failure key={failure}>{failure}</Failure>
      ))}
      <StatusLine
        state={state}
        resuming={resuming}
        showThinking={showThinking}
      />
    </>
  );
};

/**
 * A subagent's transcript inside its `task` call's card: the same Body, without the scroll area, auto-scroll or
 * queued-sends chrome — a child has no composer behind it.
 */
const NestedTranscript = ({
  state,
  conversation,
  showThinking,
}: {
  state: ConversationState;
  /** The child's own id, so its artifacts' and attachments' links scope correctly. */
  conversation: number;
  showThinking: boolean;
}) => (
  <div className="border-border flex flex-col gap-3 border-l-2 py-1 pl-4">
    <Body
      state={state}
      resuming={false}
      showThinking={showThinking}
      simple={false}
      conversation={conversation}
    />
  </div>
);

export const Transcript = ({
  state,
  conversation,
  resuming = false,
  showThinking = true,
  simple = false,
}: {
  state: ConversationState;
  /** For the attachments' links; unset on the new-conversation screen while its create is in flight. */
  conversation?: number;
  /** A resume is in flight; the run's "Working…" line reads "Resuming…" instead. */
  resuming?: boolean;
  /** The header's per-conversation switch: false drops thinking blocks, keeping text and tool calls. */
  showThinking?: boolean;
  /** The header's per-conversation switch: messages and final answers, each run's steps under "Details". */
  simple?: boolean;
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
            simple={simple}
            conversation={conversation}
          />
        </div>
      </ScrollArea>
      {showJump ? (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={jump}
          className="bg-background hover:bg-muted focus-visible:ring-ring animate-in fade-in-0 slide-in-from-bottom-2 absolute bottom-4 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border shadow-md transition-colors duration-150 outline-none focus-visible:ring-2"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
    </div>
  );
};
