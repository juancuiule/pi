// Pure read of a tool call's approval details, written by the server's withApproval wrapper
// (src/approvals.ts): pending with its decision key, approved, denied, or stopped (by a Stop before a decision).
// An `ask_user` call waits the same way and ends answered or skipped.
import type {
  AssistantMessage,
  ConversationSummary,
  EntryRecord,
} from "effect-pi/api";

import { toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

type ToolCallBlock = Extract<
  AssistantMessage["content"][number],
  { type: "toolCall" }
>;

export type Approval =
  | { readonly state: "pending"; readonly key: string }
  | { readonly state: "approved" }
  | { readonly state: "denied" }
  | { readonly state: "stopped" }
  | { readonly state: "answered" }
  | { readonly state: "skipped" };

export const approvalOf = (details: unknown): Approval | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const { approval, approvalKey } = details as Record<string, unknown>;
  if (approval === "pending" && typeof approvalKey === "string") {
    return { state: "pending", key: approvalKey };
  }
  if (approval === "approved") {
    return { state: "approved" };
  }
  if (approval === "denied") {
    return { state: "denied" };
  }
  if (approval === "stopped") {
    return { state: "stopped" };
  }
  if (approval === "answered") {
    return { state: "answered" };
  }
  if (approval === "skipped") {
    return { state: "skipped" };
  }
  return undefined;
};

/**
 * Milliseconds an approved call waited for its decision, stamped into the result's details by `withApproval` so a
 * duration can subtract it: pi's `durationMs` covers the whole execute, wait included.
 */
export const approvalWaitMsOf = (details: unknown): number | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const { approvalWaitMs } = details as Record<string, unknown>;
  return typeof approvalWaitMs === "number" ? approvalWaitMs : undefined;
};

/**
 * The decision key of a call that waits on the person: pending in its live details, no result committed yet.
 * The one definition of "waiting"; the tool card and the simple view's lift both read it.
 */
export const awaitingKey = (
  state: ConversationState,
  callId: string
): string | undefined => {
  if (toolResultOf(state, callId) !== undefined) {
    return undefined;
  }
  const approval = approvalOf(state.tools[callId]?.details);
  return approval?.state === "pending" ? approval.key : undefined;
};

/** The tool calls among `entries` that wait on the person, in transcript order. */
export const waitingCalls = (
  entries: readonly EntryRecord[],
  state: ConversationState
): readonly ToolCallBlock[] =>
  entries
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .filter(
      (block): block is ToolCallBlock =>
        block.type === "toolCall" && awaitingKey(state, block.id) !== undefined
    );

/** True while any tool call in the conversation waits for a decision. */
export const hasPendingApproval = (state: ConversationState): boolean =>
  Object.values(state.tools).some(
    (tool) => approvalOf(tool.details)?.state === "pending"
  );

/** True while a conversation has gated calls waiting for a decision. */
export const needsApproval = (
  summary: ConversationSummary | undefined
): boolean => (summary?.pendingApprovals ?? 0) > 0;
