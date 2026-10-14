// Pure read of a tool call's approval details, written by the server's withApproval wrapper
// (src/approvals.ts): pending with its decision key, approved, denied, or stopped (by a Stop before a decision).
import type { ConversationSummary } from "effect-pi/api";

import type { ConversationState } from "./conversation-state";

export type Approval =
  | { readonly state: "pending"; readonly key: string }
  | { readonly state: "approved" }
  | { readonly state: "denied" }
  | { readonly state: "stopped" };

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

/** True while any tool call in the conversation waits for a decision. */
export const hasPendingApproval = (state: ConversationState): boolean =>
  Object.values(state.tools).some(
    (tool) => approvalOf(tool.details)?.state === "pending"
  );

/** True while a conversation has gated calls waiting for a decision. */
export const needsApproval = (
  summary: ConversationSummary | undefined
): boolean => (summary?.pendingApprovals ?? 0) > 0;
