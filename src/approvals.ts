import type { Context } from "@earendil-works/chord";
// Per-conversation approval policy for gated tools. Each conversation's doc holds its policy, pending
// entries and decisions. Keys are `${conversationId}:${callId}`.
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentWatch,
  Harness,
  ToolRegistration,
} from "@earendil-works/pi-durable";

export type ApprovalPolicy = "ask" | "auto";

// oxlint-disable-next-line typescript/consistent-type-definitions -- JSON doc fields must be types
export type PendingApproval = {
  readonly conversationId: string;
  readonly callId: string;
  readonly tool: string;
  readonly requestedAt: number;
};

/** What a waiting call is told; `stop` is written by `stopWaitingCalls` just before the conversation is aborted. */
export type ApprovalDecision = "approve" | "deny" | "stop";

/** What the person decides for a waiting call; `always` approves it and turns the policy to `auto`. */
export type ApprovalChoice = "approve" | "deny" | "always";

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type ApprovalState = {
  policy: ApprovalPolicy;
  pending: Record<string, PendingApproval>;
  decisions: Record<string, ApprovalDecision>;
};

export const ApprovalDoc = defineDoc<ApprovalState>({
  kind: "app.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ policy: "auto", pending: {}, decisions: {} }),
});

export const approvalKey = (
  conversationId: ConversationId,
  callId: string
): string => `${String(conversationId)}:${callId}`;

const DENIED = "The user denied this tool call.";
export const STOPPED = "Stopped by the user before approval.";

// How long a stopped call waits for its abort before failing on its own, so a Stop whose abort never
// comes still ends the call instead of leaving it waiting.
const STOPPED_ABORT_TIMEOUT_MS = 10_000;

const withoutKey = <V>(record: Record<string, V>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

// The tools `withApproval` returned, so the console can show which ones wait for a decision under `ask`.
const gatedTools = new WeakSet<ToolRegistration>();

/** True for a tool `withApproval` returned. */
export const isGated = (tool: ToolRegistration): boolean =>
  gatedTools.has(tool);

/**
 * Wrap a gated tool: under `policy: "ask"` its execute waits for a decision committed to its
 * conversation's ApprovalDoc before running. The UI sees the call through `details.approval`.
 */
export const withApproval = (tool: ToolRegistration): ToolRegistration => {
  const wrapped: ToolRegistration = {
    ...tool,
    execute: async (args, api, context) => {
      const key = approvalKey(api.conversationId, api.callId);
      // Reading the policy and registering happen in one commit, so an "always" decision cannot land
      // between them and leave this call waiting under a policy that is already `auto`.
      const gated = await api.commit(async (tx) => {
        const doc = await tx.doc(ApprovalDoc, api.conversationId);
        if (doc.policy !== "ask") {
          return false;
        }
        doc.pending[key] = {
          conversationId: String(api.conversationId),
          callId: api.callId,
          tool: tool.name,
          requestedAt: Date.now(),
        };
        return true;
      }, context);
      if (!gated) {
        return tool.execute(args, api, context);
      }

      const signal = context.abortSignal;
      // Declared before the try so the finally can always detach the listener and stop the watch.
      let watch: DocumentWatch<ApprovalState> | undefined;
      const waiting = Promise.withResolvers<ApprovalDecision>();
      const onAbort = () => {
        waiting.reject(
          signal?.reason instanceof Error ? signal.reason : new Error("aborted")
        );
      };
      const removeEntry = () =>
        api.commit(async (tx) => {
          const doc = await tx.doc(ApprovalDoc, api.conversationId);
          doc.pending = withoutKey(doc.pending, key);
          doc.decisions = withoutKey(doc.decisions, key);
        }, context);
      try {
        await api.details({ approval: "pending", approvalKey: key }, context);
        const opened = await api.watchDoc(
          ApprovalDoc,
          api.conversationId,
          context
        );
        // Fail closed: without a watch there is no way a decision can arrive, so the tool must not run.
        if (opened === undefined) {
          throw new Error("Could not wait for approval.");
        }
        watch = opened;
        let decision = opened.value?.decisions[key];
        if (decision === undefined) {
          signal?.throwIfAborted();
          signal?.addEventListener("abort", onAbort, { once: true });
          // A closed watch (session close, retired doc) settles with no decision.
          void (async () => {
            await opened.closed;
            waiting.reject(new Error("Approval watch closed."));
          })();
          opened.start((value) => {
            const found = value?.decisions[key];
            if (found === undefined) {
              return Promise.resolve();
            }
            waiting.resolve(found);
            return Promise.resolve();
          });
          decision = await waiting.promise;
        }
        signal?.removeEventListener("abort", onAbort);
        await opened.stop();
        if (decision === "stop") {
          // The abort that follows builds this call's result from what it reported, so the reason is
          // reported first; `details` commits the output with it. Removing the entry tells
          // `stopWaitingCalls` the reason is saved and the abort can go ahead.
          api.output(STOPPED);
          await api.details({ approval: "stopped" }, context);
          await removeEntry();
          const aborted = Promise.withResolvers<boolean>();
          const timer = setTimeout(
            () => aborted.resolve(true),
            STOPPED_ABORT_TIMEOUT_MS
          );
          if (signal === undefined || signal.aborted) {
            aborted.resolve(true);
          } else {
            signal.addEventListener("abort", () => aborted.resolve(true), {
              once: true,
            });
          }
          await aborted.promise;
          clearTimeout(timer);
          throw new Error(STOPPED);
        }
        if (decision === "deny") {
          await api.details({ approval: "denied" }, context);
          throw new Error(DENIED);
        }
        if (decision !== "approve") {
          throw new Error("No approval decision.");
        }
        await api.details({ approval: "approved" }, context);
        return await tool.execute(args, api, context);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await watch?.stop().catch((): void => undefined);
        // Best-effort cleanup: the call may have been aborted, which makes the commit fail.
        await removeEntry().catch((): void => undefined);
      }
    },
  };
  gatedTools.add(wrapped);
  return wrapped;
};

/** The subset of a pi-durable Harness that `stopWaitingCalls` uses. */
type ApprovalHost = Pick<Harness, "commit" | "watchDoc">;

// How long a Stop waits for its waiting calls to save their reason before aborting anyway.
const STOP_ACK_TIMEOUT_MS = 2000;

/**
 * The first half of a Stop: decide `stop` for every call of `conversationId` waiting for approval, and
 * wait until each has reported "Stopped by the user before approval." (or `STOP_ACK_TIMEOUT_MS` passes).
 * The caller then aborts the conversation, and each call's aborted result carries that reason.
 */
export const stopWaitingCalls = async (
  host: ApprovalHost,
  conversationId: ConversationId,
  context: Context
): Promise<void> => {
  const keys = await host.commit(async (tx) => {
    const doc = await tx.doc(ApprovalDoc, conversationId);
    const waiting = Object.keys(doc.pending);
    for (const key of waiting) {
      doc.decisions[key] = "stop";
    }
    return waiting;
  }, context);
  if (keys.length === 0) {
    return;
  }
  const watch = await host.watchDoc(ApprovalDoc, conversationId, context);
  if (watch === undefined) {
    return;
  }
  const acknowledged = (value: Readonly<ApprovalState> | null) =>
    keys.every((key) => value?.pending[key] === undefined);
  try {
    if (acknowledged(watch.value)) {
      return;
    }
    const done = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => done.resolve(true), STOP_ACK_TIMEOUT_MS);
    watch.start((value) => {
      if (acknowledged(value)) {
        done.resolve(true);
      }
      return Promise.resolve();
    });
    await done.promise;
    clearTimeout(timer);
  } finally {
    await watch.stop();
  }
};

/** Forget every waiting call and decision; for after an abort, when none of those calls is still waiting. */
export const clearApprovals = async (
  host: Pick<Harness, "commit">,
  conversationId: ConversationId,
  context: Context
): Promise<void> => {
  await host.commit(async (tx) => {
    const doc = await tx.doc(ApprovalDoc, conversationId);
    doc.pending = {};
    doc.decisions = {};
  }, context);
};
