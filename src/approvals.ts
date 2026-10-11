// Per-conversation approval policy for gated tools. The root conversation's doc holds policy, pending
// entries and decisions for the whole conversation tree; a subagent's doc only carries `root` pointing
// at it. Keys are `${conversationId}:${callId}`.
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentWatch,
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

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type ApprovalState = {
  policy: ApprovalPolicy;
  /** Set on subagent conversations: the top-level conversation whose doc holds the state. */
  root?: string;
  pending: Record<string, PendingApproval>;
  decisions: Record<string, "approve" | "deny">;
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

/**
 * Wrap a gated tool: under `policy: "ask"` its execute waits for a decision committed to the root
 * conversation's ApprovalDoc before running. The UI sees the call through `details.approval`.
 */
export const withApproval = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api, context) => {
    const own = await api.snapshot(ApprovalDoc, api.conversationId, context);
    const rootId = Number(own?.root ?? api.conversationId) as ConversationId;
    const key = approvalKey(api.conversationId, api.callId);
    // Reading the policy and registering happen in one commit, so an "always" decision cannot land
    // between them and leave this call waiting under a policy that is already `auto`.
    const gated = await api.commit(async (tx) => {
      const doc = await tx.doc(ApprovalDoc, rootId);
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
    const waiting = Promise.withResolvers<"approve" | "deny">();
    const onAbort = () => {
      waiting.reject(
        signal?.reason instanceof Error ? signal.reason : new Error("aborted")
      );
    };
    try {
      await api.details({ approval: "pending", approvalKey: key }, context);
      const opened = await api.watchDoc(ApprovalDoc, rootId, context);
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
      await api
        .commit(async (tx) => {
          const doc = await tx.doc(ApprovalDoc, rootId);
          doc.pending = Object.fromEntries(
            Object.entries(doc.pending).filter(([k]) => k !== key)
          );
          doc.decisions = Object.fromEntries(
            Object.entries(doc.decisions).filter(([k]) => k !== key)
          );
        }, context)
        .catch((): void => undefined);
    }
  },
});
