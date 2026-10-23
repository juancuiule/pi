"use client";

import type { ApprovalChoice, Message } from "effect-pi/api";
import {
  CircleAlert,
  FileSearch,
  Info,
  LoaderCircle,
  SquareArrowOutUpRight,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createElement, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { approvalOf, approvalWaitMsOf, awaitingKey } from "@/lib/approval";
import { useApproval } from "@/lib/approval-context";
import { toolResultEntryOf, toolResultOf } from "@/lib/conversation-state";
import type { ConversationState, ToolRun } from "@/lib/conversation-state";
import type { ToolDiagnostic } from "@/lib/diagnostics";
import { diagnosticsOf, visibleResultContent } from "@/lib/diagnostics";
import { useOpenFile } from "@/lib/file-context";
import { formatDuration } from "@/lib/format";
import { questionsOf } from "@/lib/questions";
import { editHunksOf, isEditConfirmation, patchOf } from "@/lib/tool-input";
import { toolSummary } from "@/lib/tool-summary";
import { cn } from "@/lib/utils";
import { sourcesOf } from "@/lib/web-search";
import { filePathOf } from "@/lib/workspace-files";

import { EditPreview, FilePreview, PatchPreview } from "./file-blocks";
import { AnsweredQuestions, QuestionForm } from "./question-form";
import { toolIcon } from "./tool-icon";

type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type ToolCallBlock = Extract<
  AssistantMessage["content"][number],
  { type: "toolCall" }
>;

type ResultContent = Extract<
  Message,
  { role: "toolResult" }
>["content"][number];

const OutputBlock = ({
  text,
  language = "ansi",
  failed = false,
}: {
  text: string;
  /** Shiki language; "ansi" colors terminal output, an unknown one stays plain. */
  language?: string;
  failed?: boolean;
}) => {
  const lines = useHighlightedCode(text, language);
  return (
    <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
      <CodeBlockActions>
        <CodeBlockCopyButton value={text} />
      </CodeBlockActions>
      <CodeBlockContent wrap className="max-h-80">
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no id; output only grows or is replaced
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

const ResultBlock = ({
  block,
  failed,
}: {
  block: ResultContent;
  failed: boolean;
}) =>
  block.type === "text" ? (
    <OutputBlock text={block.text} failed={failed} />
  ) : (
    // oxlint-disable-next-line next/no-img-element -- inline data URL, nothing for next/image to optimize
    <img
      src={`data:${block.mimeType};base64,${block.data}`}
      alt="Tool screenshot"
      className="max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
    />
  );

const pathArg = (call: ToolCallBlock): string | undefined => {
  const { path } = (call.arguments ?? {}) as Record<string, unknown>;
  return typeof path === "string" ? path : undefined;
};

const Arguments = ({
  call,
  toolResult,
}: {
  call: ToolCallBlock;
  toolResult: ToolResult | undefined;
}) => {
  const args = call.arguments as Record<string, unknown> | undefined;
  const path = pathArg(call);
  if (call.name === "write") {
    const content = args?.content;
    if (path !== undefined && typeof content === "string") {
      return <FilePreview path={path} content={content} />;
    }
  }
  // The requested-hunks diff matters only before the result lands; a finished edit's real patch supersedes it.
  if (
    call.name === "edit" &&
    path !== undefined &&
    patchOf(toolResult?.details) === undefined
  ) {
    const hunks = editHunksOf(args);
    if (hunks.length > 0) {
      return <EditPreview path={path} hunks={hunks} />;
    }
  }
  const command =
    call.name === "bash" && typeof args?.command === "string"
      ? args.command
      : undefined;
  return (
    <OutputBlock
      text={command ?? JSON.stringify(call.arguments ?? {}, null, 2)}
      language={command === undefined ? "text" : "bash"}
    />
  );
};

const ApprovalActions = ({ approvalKey }: { approvalKey: string }) => {
  const approvalMutation = useApproval();
  const decide = (decision: ApprovalChoice) => {
    approvalMutation?.mutate(
      { key: approvalKey, decision },
      { onError: (error) => toast.error(error.message, { duration: Infinity }) }
    );
  };
  return (
    <div className="flex flex-wrap gap-2">
      {(
        [
          ["approve", "Run once", "default"],
          ["always", "Always allow", "outline"],
          ["deny", "Deny", "destructive"],
        ] as const
      ).map(([decision, label, variant]) => (
        <Button
          key={decision}
          size="sm"
          variant={variant}
          disabled={approvalMutation?.isPending}
          onClick={() => decide(decision)}
        >
          {approvalMutation?.isPending &&
          approvalMutation.variables?.decision === decision &&
          approvalMutation.variables?.key === approvalKey ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : null}
          {label}
        </Button>
      ))}
    </div>
  );
};

/**
 * Controlled open state: the line never opens or closes on its own after mount (base-ui warns about a
 * changing defaultOpen otherwise), except the one transition into awaiting approval.
 */
const useToolCallOpen = (initial: boolean, pending: boolean) => {
  const [open, setOpen] = useState(initial);
  // "Adjust state during render" (React docs): open once when pending appears, never close on the user.
  const [wasPending, setWasPending] = useState(pending);
  if (pending !== wasPending) {
    setWasPending(pending);
    if (pending) {
      setOpen(true);
    }
  }
  return [open, setOpen] as const;
};

/** How the person settled the call, if the server put it in details; whether it still waits is `awaitingKey`'s. */
const approvalFor = (
  toolResult: Extract<Message, { role: "toolResult" }> | undefined,
  tool: ToolRun | undefined
) => {
  const approval = approvalOf(toolResult?.details) ?? approvalOf(tool?.details);
  return {
    denied: approval?.state === "denied",
    stopped: approval?.state === "stopped",
    skipped: approval?.state === "skipped",
  };
};

/** What the call is doing now, decided once — drives the line's status, label and icon. */
type CallState =
  | "skipped"
  | "denied"
  | "stopped"
  | "awaiting"
  | "failed"
  | "running"
  | "interrupted"
  | "done";

const callState = (
  approval: ReturnType<typeof approvalFor>,
  awaiting: boolean,
  isError: boolean,
  finished: boolean,
  running: boolean
): CallState => {
  if (approval.skipped) {
    return "skipped";
  }
  if (approval.denied) {
    return "denied";
  }
  if (approval.stopped) {
    return "stopped";
  }
  if (awaiting) {
    return "awaiting";
  }
  if (isError) {
    return "failed";
  }
  if (!finished) {
    return running ? "running" : "interrupted";
  }
  return "done";
};

const stateIcon = (step: CallState, icon: LucideIcon): ReactNode => {
  if (step === "running") {
    return <LoaderCircle className="motion-safe:animate-spin" />;
  }
  if (step === "failed") {
    return <CircleAlert />;
  }
  return createElement(icon);
};

const LABELS: Record<CallState, string | undefined> = {
  skipped: "Skipped",
  denied: "Denied",
  stopped: "Stopped",
  awaiting: "Needs approval",
  failed: "Failed",
  running: "Running",
  interrupted: "Stopped",
  done: undefined,
};

const LINE_STATUS: Record<
  CallState,
  "running" | "error" | "pending" | undefined
> = {
  skipped: undefined,
  denied: undefined,
  stopped: undefined,
  awaiting: "pending",
  failed: "error",
  running: "running",
  interrupted: undefined,
  done: undefined,
};

const Section = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1">
    <span className="text-muted-foreground text-xs font-medium">{label}</span>
    {children}
  </div>
);

/** The harness's `<harness>` diagnostics, rendered as notes in place of the model-facing markup. */
const DIAGNOSTIC_META: Record<
  ToolDiagnostic["severity"],
  { readonly Icon: LucideIcon; readonly className: string }
> = {
  error: { Icon: CircleAlert, className: "text-destructive" },
  warn: { Icon: TriangleAlert, className: "text-warning" },
  info: { Icon: Info, className: "text-muted-foreground" },
};

const Diagnostics = ({
  items,
}: {
  readonly items: readonly ToolDiagnostic[];
}) => (
  <div className="flex flex-col gap-1">
    {items.map((item, index) => {
      const { Icon, className } = DIAGNOSTIC_META[item.severity];
      return (
        // oxlint-disable-next-line react/no-array-index-key -- a result's diagnostics are fixed
        <p
          key={index}
          className={cn("flex items-start gap-1.5 text-xs", className)}
        >
          <Icon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0"
            strokeWidth={1.5}
          />
          <span>{item.message}</span>
        </p>
      );
    })}
  </div>
);

/** The host a source link points to, shown muted beside its title. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

/** `details.sources` of a finished search: the pages the agent drew from, as links that leave the console. */
const Sources = ({ details }: { readonly details: unknown }) => {
  const sources = sourcesOf(details);
  if (sources.length === 0) {
    return null;
  }
  return (
    <Section label="Sources">
      <ol className="flex flex-col gap-1">
        {sources.map((source) => (
          <li key={source.url} className="flex items-baseline gap-1.5 text-xs">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground/80 inline-flex items-baseline gap-1 underline-offset-2 hover:underline"
            >
              {source.title}
              <SquareArrowOutUpRight
                aria-hidden
                className="text-muted-foreground size-3 shrink-0 self-center"
                strokeWidth={1.5}
              />
            </a>
            <span className="text-muted-foreground">
              {hostOf(source.url)}
              {source.publishedDate === undefined
                ? ""
                : ` · ${source.publishedDate}`}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
};

/** Whether the call carries arguments worth showing; `{}` (a tool with no input) hides the section. */
const hasInput = (call: ToolCallBlock): boolean => {
  const args: unknown = call.arguments;
  return typeof args === "object" && args !== null
    ? Object.keys(args).length > 0
    : args !== undefined && args !== null;
};

type ToolResult = Extract<Message, { role: "toolResult" }>;

/** The Output section: live text while running; diff, content blocks and diagnostics once finished. */
const CallOutput = ({
  call,
  tool,
  toolResult,
  diagnostics,
}: {
  readonly call: ToolCallBlock;
  readonly tool: ToolRun | undefined;
  readonly toolResult: ToolResult | undefined;
  readonly diagnostics: readonly ToolDiagnostic[];
}) => {
  const finished = toolResult !== undefined;
  const editPatch =
    call.name === "edit" ? patchOf(toolResult?.details) : undefined;
  const visibleContent = finished
    ? visibleResultContent(toolResult.content, diagnostics).filter(
        (block) =>
          editPatch === undefined ||
          block.type !== "text" ||
          !isEditConfirmation(block.text)
      )
    : [];
  const hasOutput = finished
    ? editPatch !== undefined ||
      visibleContent.length > 0 ||
      diagnostics.length > 0
    : (tool?.output ?? "") !== "";
  if (!hasOutput) {
    return null;
  }
  return (
    <Section label="Output">
      {finished ? (
        <>
          {editPatch === undefined ? null : <PatchPreview patch={editPatch} />}
          {visibleContent.map((block, index) => (
            <ResultBlock
              key={`${call.id}:${index}`}
              block={block}
              failed={toolResult.isError}
            />
          ))}
          <Diagnostics items={diagnostics} />
        </>
      ) : (
        <OutputBlock text={tool?.output ?? ""} />
      )}
    </Section>
  );
};

/**
 * Execution time from the committed result: pi's durationMs less the approval wait. Nothing while the call runs —
 * the wire carries no live timer — and nothing for denied, stopped or skipped calls, which never executed.
 */
const elapsedOf = (
  step: CallState,
  toolResult: ToolResult | undefined
): string | undefined => {
  const durationMs = toolResult?.durationMs;
  return durationMs === undefined ||
    step === "denied" ||
    step === "stopped" ||
    step === "skipped"
    ? undefined
    : formatDuration(
        Math.max(0, durationMs - (approvalWaitMsOf(toolResult?.details) ?? 0))
      );
};

/** `ask_user` waits for answers, not a go-ahead: its form, then the answers, replace the raw input and output. */
const QuestionsBody = ({
  call,
  toolResult,
  pendingKey,
  step,
}: {
  readonly call: ToolCallBlock;
  readonly toolResult: ToolResult | undefined;
  readonly pendingKey: string | undefined;
  readonly step: CallState;
}) => {
  const questions = questionsOf(call.arguments);
  if (pendingKey !== undefined) {
    return <QuestionForm questions={questions} answerKey={pendingKey} />;
  }
  if (step === "done") {
    return (
      <AnsweredQuestions questions={questions} details={toolResult?.details} />
    );
  }
  return null;
};

const CallBody = ({
  call,
  tool,
  toolResult,
  diagnostics,
  pendingKey,
  step,
  extra,
}: {
  readonly call: ToolCallBlock;
  readonly tool: ToolRun | undefined;
  readonly toolResult: ToolResult | undefined;
  readonly diagnostics: readonly ToolDiagnostic[];
  readonly pendingKey: string | undefined;
  readonly step: CallState;
  /** A call-specific extra body — a `task` call's nested subagent transcript. */
  readonly extra?: ReactNode;
}) => {
  const asking =
    call.name === "ask_user" && questionsOf(call.arguments).length > 0;
  return (
    <div className="flex flex-col gap-3">
      {asking ? (
        <QuestionsBody
          call={call}
          toolResult={toolResult}
          pendingKey={pendingKey}
          step={step}
        />
      ) : (
        <>
          {hasInput(call) ? (
            <Section label="Input">
              <Arguments call={call} toolResult={toolResult} />
            </Section>
          ) : null}
          {pendingKey === undefined ? null : (
            <ApprovalActions approvalKey={pendingKey} />
          )}
          {extra}
        </>
      )}
      {asking && step !== "failed" ? null : (
        <CallOutput
          call={call}
          tool={tool}
          toolResult={toolResult}
          diagnostics={diagnostics}
        />
      )}
      <Sources details={toolResult?.details} />
    </div>
  );
};

export const ToolCall = ({
  call,
  state,
  extra,
}: {
  call: ToolCallBlock;
  state: ConversationState;
  /** A call-specific extra body — a `task` call's nested subagent transcript. */
  extra?: ReactNode;
}) => {
  const openFile = useOpenFile();
  const filePath = filePathOf(call.name, call.arguments);
  const tool = state.tools[call.id];
  const resultEntry = toolResultEntryOf(state, call.id);
  const toolResult = toolResultOf(state, call.id);
  const diagnostics = diagnosticsOf(resultEntry?.data);
  const finished = toolResult !== undefined;
  const isError = toolResult?.isError ?? false;
  const summary = toolSummary(call.name, call.arguments);
  const Icon = toolIcon(call.name);
  const pendingKey = awaitingKey(state, call.id);
  const step = callState(
    approvalFor(toolResult, tool),
    pendingKey !== undefined,
    isError,
    finished,
    state.running
  );
  const label =
    call.name === "ask_user" && step === "awaiting"
      ? "Needs answers"
      : LABELS[step];
  const labelNode =
    step === "awaiting" ? <span className="text-warning">{label}</span> : label;

  const [open, setOpen] = useToolCallOpen(
    isError || !finished,
    pendingKey !== undefined
  );

  const elapsed = elapsedOf(step, toolResult);

  return (
    <div className="group/tool-call flex items-start">
      <TraceCollapsible
        open={open}
        onOpenChange={setOpen}
        className="min-w-0 flex-1"
      >
        <TraceCollapsibleTrigger>
          <TraceLine status={LINE_STATUS[step]}>
            <TraceIcon>{stateIcon(step, Icon)}</TraceIcon>
            <TraceTitle>
              <span className="text-foreground/80 font-mono font-medium">
                {call.name}
              </span>
              {summary === "" ? null : (
                <span className="font-mono"> {summary}</span>
              )}
            </TraceTitle>
            {labelNode === undefined && elapsed === undefined ? null : (
              <TraceDescription>
                {labelNode}
                {labelNode !== undefined && elapsed !== undefined
                  ? " · "
                  : null}
                {elapsed}
              </TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CallBody
            call={call}
            tool={tool}
            toolResult={toolResult}
            diagnostics={diagnostics}
            pendingKey={pendingKey}
            step={step}
            extra={extra}
          />
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {/* A workspace path the call names opens in the file pane beside the chat. */}
      {filePath === undefined || openFile === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Open ${filePath}`}
                onClick={() => openFile({ path: filePath })}
              >
                <FileSearch />
              </Button>
            }
          />
          <TooltipContent>Open file</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
