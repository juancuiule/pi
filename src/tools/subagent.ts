// `task`: the agent hands a self-contained piece of work to a subagent — a child conversation with its own
// context, on the parent's machine, files and skills. The call blocks until the child finishes and returns the
// child's final answer as the tool result; several `task` calls in one round run in parallel. The child is owned
// by this call's task, so a retry after a crash finds it instead of creating another, and aborting the call
// aborts the child. The console streams the child's transcript inside the call's card through
// details.conversationId.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  EntryId,
  Extension,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable";

import { UPGRADE_WORKSPACE } from "./workspace.ts";

/** More than this many subagents of one conversation at once fails fast: fan-out is bounded. */
export const MAX_SUBAGENTS = 4;

const answerText = async (
  api: ToolExecutionApi,
  answer: EntryId,
  context: Context
): Promise<string> => {
  const entry = await api.commit(
    (tx) => tx.entry(AssistantEntry, answer),
    context
  );
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  return (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
};

// Live children of one conversation: task-owned conversations whose owner task has not reached a terminal
// state. Children persist after their call ends, so the count must look past them.
const liveChildren = async (
  tx: Tx,
  conversationId: ConversationId
): Promise<number> => {
  let count = 0;
  let cursor: Cursor | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by cursor
    const page = await tx.scanConversations(
      { ownerConversationId: conversationId },
      100,
      cursor
    );
    const owners = page.items.flatMap((child) =>
      child.owner === undefined ? [] : [child.owner.taskId]
    );
    // oxlint-disable-next-line no-await-in-loop -- a tx answers one read at a time
    const tasks = await Promise.all(owners.map((taskId) => tx.task(taskId)));
    count += tasks.filter(
      (task) => task !== undefined && task.state.status !== "terminal"
    ).length;
    cursor = page.next;
  } while (cursor !== undefined);
  return count;
};

export const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "task",
      description:
        "Delegate a self-contained piece of work to a subagent: a child conversation with its own context, working on the same files with the same skills. This call blocks until the subagent finishes and returns its final answer. Use it for self-contained work or a long search that would otherwise fill your context; issue several `task` calls in one reply to run them in parallel.",
      parameters: Type.Object({
        prompt: Type.String({
          description: "What the subagent should do, self-contained",
        }),
      }),
      // Safe to rerun after a crash: a rerun finds the child it created and the submission it made.
      replay: "safe",
      execute: async ({ prompt }, api, callContext) => {
        // The child is owned by this tool call's task: aborting the call aborts the child, and the call
        // finishes only once the child's work is done.
        const child = await api.commit(async (tx) => {
          // Ownership records the child: a rerun of this call finds it instead of creating another.
          const page = await tx.scanConversations(
            { ownerTaskId: api.taskId },
            1
          );
          const [existing] = page.items;
          if (existing !== undefined) {
            return existing.id;
          }
          // The cap is read inside the creating commit so parallel `task` calls cannot slip past it.
          if ((await liveChildren(tx, api.conversationId)) >= MAX_SUBAGENTS) {
            return;
          }
          const record = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          // The child starts as a copy of this conversation's agent — model, thinking, cwd, extensions,
          // tools — minus `task` itself (children do not delegate)…
          await configure(tx, record.id, {
            extensions: { remove: [Subagent] },
          });
          // …and `upgrade_workspace`, which would replace the sandbox the whole tree shares.
          const agent = await tx.doc(AgentDoc, record.id);
          const { tools } = agent;
          agent.tools = Array.isArray(tools)
            ? tools.filter((name) => name !== UPGRADE_WORKSPACE)
            : { remove: [...(tools?.remove ?? []), UPGRADE_WORKSPACE] };
          return record.id;
        }, callContext);
        if (child === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `Too many subagents are already working — at most ${MAX_SUBAGENTS} task calls may run at once. Wait for one to finish, then try again.`,
              },
            ],
            isError: true,
          };
        }
        // A UI watching the parent sees this and can attach to the child.
        await api.details({ conversationId: child }, callContext);
        const handle = await api.conversation(child, callContext);
        if (handle === undefined) {
          throw new Error(`Subagent conversation ${String(child)} not found`);
        }
        // The request ID makes a rerun get back the submission it made before the crash.
        const submission = await handle.submit(
          {
            type: "input",
            content: prompt,
            requestId: `subagent:${api.taskId}`,
          },
          callContext
        );
        const settled = await submission.wait(callContext);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent failed: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer, callContext);
        return {
          content: [{ type: "text", text }],
          details: { conversationId: child },
        };
      },
    }),
  ],
});
