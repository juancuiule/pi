// Pure read of a tool call's approval details, written by the server's withApproval wrapper
// (src/approvals.ts): pending with its decision key, or approved.
import type { ConversationSummary } from "effect-pi/api";

import type { ConversationState } from "./conversation-state";

export type Approval =
  | { readonly state: "pending"; readonly key: string }
  | { readonly state: "approved" }
  | { readonly state: "denied" };

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
  return undefined;
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
