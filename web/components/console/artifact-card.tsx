"use client";

import type { Message } from "effect-pi/api";
import { CircleAlert, LayoutTemplate, LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useOpenArtifact } from "@/lib/artifact-context";
import type { ArtifactRef } from "@/lib/artifacts";
import { artifactOf } from "@/lib/artifacts";
import { toolResultOf } from "@/lib/conversation-state";
import type { ConversationState } from "@/lib/conversation-state";
import { cn } from "@/lib/utils";

import type { ToolCallBlock } from "./tool-call";

type ToolResult = Extract<Message, { role: "toolResult" }>;

/** The first text a tool result carries, for a failed call's card. */
const errorText = (toolResult: ToolResult | undefined): string | undefined => {
  const block = toolResult?.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : undefined;
};

const subtitleOf = (
  call: ToolCallBlock,
  ref: ArtifactRef | undefined,
  toolResult: ToolResult | undefined,
  running: boolean
): string => {
  if (toolResult?.isError === true) {
    return errorText(toolResult) ?? "Failed";
  }
  if (running) {
    return call.name === "artifact_update"
      ? "Updating the page…"
      : "Writing the page…";
  }
  return ref === undefined ? "Page" : `v${ref.version}`;
};

const CardIcon = ({
  failed,
  running,
}: {
  failed: boolean;
  running: boolean;
}) => {
  const Icon: LucideIcon = failed ? CircleAlert : LayoutTemplate;
  return running ? (
    <LoaderCircle className="size-4 motion-safe:animate-spin" />
  ) : (
    <Icon className="size-4" />
  );
};

/**
 * The compact card an `artifact_*` call leaves in the transcript, in place of a tool call's trace row: the page's
 * title and version, and an Open action once the result's details name the artifact.
 */
export const ArtifactCard = ({
  call,
  state,
}: {
  call: ToolCallBlock;
  state: ConversationState;
}) => {
  const openArtifact = useOpenArtifact();
  const toolResult = toolResultOf(state, call.id);
  const ref =
    artifactOf(toolResult?.details) ??
    artifactOf(state.tools[call.id]?.details);
  const args = call.arguments as Record<string, unknown> | undefined;
  const title =
    ref?.title ??
    (typeof args?.title === "string" ? args.title : undefined) ??
    "Page";
  const failed = toolResult?.isError === true;
  const running = toolResult === undefined && state.running;
  return (
    <button
      type="button"
      disabled={ref === undefined || openArtifact === undefined}
      onClick={() =>
        ref !== undefined &&
        openArtifact?.({ id: ref.id, version: ref.version })
      }
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl border px-3 py-2 text-left transition-colors",
        failed
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "enabled:hover:bg-muted/50 disabled:cursor-default"
      )}
    >
      <span
        className={cn(
          "bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md",
          failed && "bg-destructive/10 text-destructive"
        )}
      >
        <CardIcon failed={failed} running={running} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "text-foreground block truncate text-sm font-medium",
            failed && "text-destructive"
          )}
          title={title}
        >
          {title}
        </span>
        <span
          className={cn(
            "text-muted-foreground block truncate text-xs",
            failed && "text-destructive/80"
          )}
        >
          {subtitleOf(call, ref, toolResult, running)}
        </span>
      </span>
      {ref === undefined ? null : (
        <span className="text-muted-foreground shrink-0 text-xs">Open</span>
      )}
    </button>
  );
};
