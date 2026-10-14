"use client";

import type { ApprovalChoice, Message } from "effect-pi/api";
import {
  CircleAlert,
  FileCode,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createElement, Fragment, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
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
import { approvalOf } from "@/lib/approval";
import { useApproval } from "@/lib/approval-context";
import { toolResultEntryOf, toolResultOf } from "@/lib/conversation-state";
import type { ConversationState, ToolRun } from "@/lib/conversation-state";
import type { ToolDiagnostic } from "@/lib/diagnostics";
import { diagnosticsOf, visibleResultContent } from "@/lib/diagnostics";
import type { EditHunk } from "@/lib/tool-input";
import {
  diffOf,
  diffRowsOf,
  editHunksOf,
  fileLanguage,
  isEditConfirmation,
} from "@/lib/tool-input";
import { toolSummary } from "@/lib/tool-summary";
import { cn } from "@/lib/utils";

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

/** A file being written: the path as title, its content highlighted and numbered like an editor. */
const FileBlock = ({ path, content }: { path: string; content: string }) => {
  const lines = useHighlightedCode(content, fileLanguage(path));
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCode aria-hidden />
          {path}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={content} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers className="max-h-80">
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no id; input only grows or is replaced
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

/** One requested replacement: old lines removed, new lines added, highlighted as the file's language. */
const HunkLines = ({
  hunk,
  language,
}: {
  readonly hunk: EditHunk;
  readonly language: string;
}) => {
  const removed = useHighlightedCode(hunk.oldText, language);
  const added = useHighlightedCode(hunk.newText, language);
  return (
    <>
      {removed.map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <CodeBlockLine key={`r${index}`} variant="removed">
          {line}
        </CodeBlockLine>
      ))}
      {added.map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <CodeBlockLine key={`a${index}`} variant="added">
          {line}
        </CodeBlockLine>
      ))}
    </>
  );
};

/** The edit a call asks for, shown as a diff before the result's real diff exists. */
const EditInput = ({
  path,
  hunks,
}: {
  readonly path: string;
  readonly hunks: readonly EditHunk[];
}) => {
  const language = fileLanguage(path);
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCode aria-hidden />
          {path}
        </CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent className="max-h-80">
        {hunks.map((hunk, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- hunks have no id; input only grows or is replaced
          <Fragment key={index}>
            {index === 0 ? null : <CodeBlockLine>…</CodeBlockLine>}
            <HunkLines hunk={hunk} language={language} />
          </Fragment>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

/** The real diff a finished edit produced (`details.diff`), tinted per row. */
const DiffBlock = ({
  path,
  diff,
}: {
  readonly path: string | undefined;
  readonly diff: string;
}) => (
  <CodeBlock size="sm">
    {path === undefined ? null : (
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCode aria-hidden />
          {path}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={diff} />
        </CodeBlockActions>
      </CodeBlockHeader>
    )}
    <CodeBlockContent className="max-h-80">
      {diffRowsOf(diff).map((row, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- diff rows are fixed for a result
        <CodeBlockLine key={index} variant={row.variant}>
          {row.text}
        </CodeBlockLine>
      ))}
    </CodeBlockContent>
  </CodeBlock>
);

const Arguments = ({ call }: { call: ToolCallBlock }) => {
  const args = call.arguments as Record<string, unknown> | undefined;
  const path = pathArg(call);
  if (call.name === "write") {
    const content = args?.content;
    if (path !== undefined && typeof content === "string") {
      return <FileBlock path={path} content={content} />;
    }
  }
  if (call.name === "edit" && path !== undefined) {
    const hunks = editHunksOf(args);
    if (hunks.length > 0) {
      return <EditInput path={path} hunks={hunks} />;
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
      { onError: (error) => toast.error(error.message) }
    );
  };
  return (
    <div className="flex flex-wrap gap-2">
      {(
        [
          ["approve", "Run", "default"],
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

/** The call's approval state, if the server put one in details; `awaiting` only while no result exists. */
const approvalFor = (
  toolResult: Extract<Message, { role: "toolResult" }> | undefined,
  tool: ToolRun | undefined
) => {
  const approval = approvalOf(toolResult?.details) ?? approvalOf(tool?.details);
  return {
    key: approval?.state === "pending" ? approval.key : undefined,
    awaiting: approval?.state === "pending" && toolResult === undefined,
    denied: approval?.state === "denied",
    stopped: approval?.state === "stopped",
  };
};

/** What the call is doing now, decided once — drives the line's status, label and icon. */
type CallState =
  | "denied"
  | "stopped"
  | "awaiting"
  | "failed"
  | "running"
  | "interrupted"
  | "done";

const callState = (
  approval: ReturnType<typeof approvalFor>,
  isError: boolean,
  finished: boolean,
  running: boolean
): CallState => {
  if (approval.denied) {
    return "denied";
  }
  if (approval.stopped) {
    return "stopped";
  }
  if (approval.awaiting) {
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
          <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{item.message}</span>
        </p>
      );
    })}
  </div>
);

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
  const editDiff =
    call.name === "edit" ? diffOf(toolResult?.details) : undefined;
  const visibleContent = finished
    ? visibleResultContent(toolResult.content, diagnostics).filter(
        (block) =>
          editDiff === undefined ||
          block.type !== "text" ||
          !isEditConfirmation(block.text)
      )
    : [];
  const hasOutput = finished
    ? editDiff !== undefined ||
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
          {editDiff === undefined ? null : (
            <DiffBlock path={pathArg(call)} diff={editDiff} />
          )}
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

export const ToolCall = ({
  call,
  state,
}: {
  call: ToolCallBlock;
  state: ConversationState;
}) => {
  const tool = state.tools[call.id];
  const resultEntry = toolResultEntryOf(state, call.id);
  const toolResult = toolResultOf(state, call.id);
  const diagnostics = diagnosticsOf(resultEntry?.data);
  const finished = toolResult !== undefined;
  const isError = toolResult?.isError ?? false;
  const summary = toolSummary(call.name, call.arguments);
  const Icon = toolIcon(call.name);
  const approval = approvalFor(toolResult, tool);
  const step = callState(approval, isError, finished, state.running);
  const label = LABELS[step];
  const labelNode =
    step === "awaiting" ? <span className="text-warning">{label}</span> : label;

  const [open, setOpen] = useToolCallOpen(
    isError || !finished,
    approval.awaiting
  );

  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
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
          {labelNode === undefined ? null : (
            <TraceDescription>{labelNode}</TraceDescription>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-3">
          {hasInput(call) ? (
            <Section label="Input">
              <Arguments call={call} />
            </Section>
          ) : null}
          {approval.awaiting && approval.key !== undefined ? (
            <ApprovalActions approvalKey={approval.key} />
          ) : null}
          <CallOutput
            call={call}
            tool={tool}
            toolResult={toolResult}
            diagnostics={diagnostics}
          />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};
