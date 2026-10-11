"use client";

import type { Message } from "effect-pi/api";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toolResultOf } from "@/lib/conversation-state";
import type { ConversationState, ToolRun } from "@/lib/conversation-state";
import { cn } from "@/lib/utils";

type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type ToolCallBlock = Extract<
  AssistantMessage["content"][number],
  { type: "toolCall" }
>;

type ResultContent = Extract<
  Message,
  { role: "toolResult" }
>["content"][number];

const LiveOutput = ({ output }: { output: string }) =>
  output === "" ? null : (
    <pre className="bg-muted max-h-80 overflow-auto rounded p-2 text-xs">
      {output}
    </pre>
  );

const ResultBlock = ({ block }: { block: ResultContent }) =>
  block.type === "text" ? (
    <pre className="bg-muted max-h-80 overflow-auto rounded p-2 text-xs">
      {block.text}
    </pre>
  ) : (
    // oxlint-disable-next-line next/no-img-element -- inline data URL, nothing for next/image to optimize
    <img
      src={`data:${block.mimeType};base64,${block.data}`}
      alt="Tool screenshot"
      className="max-w-full rounded border"
    />
  );

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
  const isError = toolResult?.isError === true;

  return (
    <div
      className={cn(
        "rounded-xl border border-transparent",
        isError && "border-destructive"
      )}
    >
      <Card size="sm">
        <div className="flex items-center gap-2 px-3">
          <span className="font-mono font-medium">{call.name}</span>
          <Badge variant="secondary">{status}</Badge>
          {isError ? <Badge variant="destructive">error</Badge> : null}
        </div>
        <div className="px-3">
          <Collapsible defaultOpen>
            <div className="text-muted-foreground text-xs">
              <CollapsibleTrigger>Arguments</CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <pre className="bg-muted overflow-x-auto rounded p-2 text-xs">
                {JSON.stringify(call.arguments, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
        {renderExtra?.(call, tool)}
        <div className="flex flex-col gap-2 px-3">
          {toolResult === undefined ? (
            <LiveOutput output={tool?.output ?? ""} />
          ) : (
            toolResult.content.map((c, index) => (
              <ResultBlock key={`${call.id}:${index}`} block={c} />
            ))
          )}
        </div>
      </Card>
    </div>
  );
};
