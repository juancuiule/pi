"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import type { Message } from "effect-pi/api";
import {
  Ban,
  Check,
  ChevronRight,
  CircleX,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { createElement, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { approvalOf } from "@/lib/approval";
import { useApproval } from "@/lib/approval-context";
import { toolResultOf } from "@/lib/conversation-state";
import type { ConversationState, ToolRun } from "@/lib/conversation-state";
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

const OutputPre = ({ text }: { text: string }) => (
  <pre className="bg-muted text-code max-h-80 overflow-auto rounded-md p-3 font-mono break-words whitespace-pre-wrap">
    {text}
  </pre>
);

const LiveOutput = ({ output }: { output: string }) =>
  output === "" ? null : <OutputPre text={output} />;

const ResultBlock = ({ block }: { block: ResultContent }) =>
  block.type === "text" ? (
    <OutputPre text={block.text} />
  ) : (
    // oxlint-disable-next-line next/no-img-element -- inline data URL, nothing for next/image to optimize
    <img
      src={`data:${block.mimeType};base64,${block.data}`}
      alt="Tool screenshot"
      className="max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
    />
  );

const Status = ({
  status,
  isError,
  needsApproval,
  denied,
}: {
  status: "pending" | "running" | "done";
  isError: boolean;
  needsApproval: boolean;
  denied: boolean;
}) => {
  if (denied) {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        <Ban className="size-3.5" />
        Denied
      </span>
    );
  }
  if (needsApproval) {
    return (
      <span className="text-warning flex items-center gap-1 text-xs">
        <ShieldAlert className="size-3.5" />
        Needs approval
      </span>
    );
  }
  if (isError) {
    return (
      <span className="text-destructive flex items-center gap-1 text-xs">
        <CircleX className="size-3.5" />
        Failed
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="text-muted-foreground flex items-center">
        <Check className="size-3.5" />
        <span className="sr-only">Done</span>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground flex items-center">
      <LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />
      <span className="sr-only">Running</span>
    </span>
  );
};

const Arguments = ({ call }: { call: ToolCallBlock }) => {
  const args = call.arguments as Record<string, unknown> | undefined;
  if (call.name === "bash" && typeof args?.command === "string") {
    return <OutputPre text={args.command} />;
  }
  return <OutputPre text={JSON.stringify(call.arguments ?? {}, null, 2)} />;
};

const ApprovalActions = ({ approvalKey }: { approvalKey: string }) => {
  const approvalMutation = useApproval();
  const decide = (decision: "approve" | "deny" | "always") => {
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
 * Controlled open state: the card never opens or closes on its own after mount (base-ui warns about a
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
  };
};

export const ToolCall = ({
  call,
  state,
  renderExtra,
}: {
  call: ToolCallBlock;
  state: ConversationState;
  renderExtra?: (call: ToolCallBlock, tool: ToolRun | undefined) => ReactNode;
}) => {
  const tool = state.tools[call.id];
  const result = toolResultOf(state, call.id);
  const toolResult = result?.role === "toolResult" ? result : undefined;
  const status =
    toolResult === undefined ? (tool?.status ?? "pending") : "done";
  const isError = toolResult?.isError ?? false;
  const summary = toolSummary(call.name, call.arguments);
  const Icon = toolIcon(call.name);
  const extra = renderExtra?.(call, tool);
  const approval = approvalFor(toolResult, tool);
  const awaitingApproval = approval.awaiting;
  const [open, setOpen] = useToolCallOpen(
    isError || status !== "done",
    awaitingApproval
  );

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "bg-card rounded-lg border",
          isError && !approval.denied && "border-destructive/50"
        )}
      >
        <Collapsible.Trigger className="group focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2">
          {createElement(Icon, {
            className: "text-muted-foreground size-3.5 shrink-0",
            "aria-hidden": true,
          })}
          <span className="text-ui shrink-0 font-mono font-medium">
            {call.name}
          </span>
          <span
            className="text-muted-foreground text-ui min-w-0 flex-1 truncate font-mono"
            title={summary}
          >
            {summary}
          </span>
          <Status
            status={status}
            isError={isError}
            needsApproval={awaitingApproval}
            denied={approval.denied}
          />
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90" />
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <div className="flex flex-col gap-3 border-t px-3 py-3">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">
                Input
              </span>
              <Arguments call={call} />
            </div>
            {awaitingApproval && approval.key !== undefined ? (
              <ApprovalActions approvalKey={approval.key} />
            ) : null}
            {extra}
            {toolResult === undefined && tool?.output === "" ? null : (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs font-medium">
                  Output
                </span>
                {toolResult === undefined ? (
                  <LiveOutput output={tool?.output ?? ""} />
                ) : (
                  toolResult.content.map((c, index) => (
                    <ResultBlock key={`${call.id}:${index}`} block={c} />
                  ))
                )}
              </div>
            )}
          </div>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
};
