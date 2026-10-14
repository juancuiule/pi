// The agent's Upgrade: a tool that raises its conversation's Workspace to a higher Level when a task needs a shell or
// a desktop. Under the `ask` approval policy the person approves it first; when there is no room, it waits until the
// person frees some (see Capacity), and a Stop or a cancelled wait ends it with an error the model can read.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";

import { withApproval } from "../approvals.ts";

/** Raise `conversationId`'s Workspace to `level`; resolves with a sentence for the model, rejects on failure. */
export type UpgradeWorkspace = (
  conversationId: ConversationId,
  level: "shell" | "desktop",
  signal: AbortSignal | undefined
) => Promise<string>;

export const workspaceExtension = (upgrade: UpgradeWorkspace): Extension =>
  defineExtension({
    name: "workspace",
    tools: [
      withApproval(
        defineTool({
          name: "upgrade_workspace",
          description:
            "Get a bigger machine for this conversation: `shell` adds a Linux shell with file tools, `desktop` adds a graphical desktop on top. Your files in /workspace carry over; installed packages do not. Use it only when the task needs it, and say why.",
          parameters: Type.Object({
            level: Type.Union(
              [Type.Literal("shell"), Type.Literal("desktop")],
              {
                description: "The Level to raise the workspace to",
              }
            ),
            reason: Type.String({
              description: "Why the task needs it, shown to the person",
            }),
          }),
          // Creates a Sandbox and takes Capacity: never rerun blindly after a crash.
          replay: "unsafe",
          execute: async ({ level }, api, context) => ({
            content: [
              {
                type: "text",
                text: await upgrade(
                  api.conversationId,
                  level,
                  context.abortSignal
                ),
              },
            ],
          }),
        })
      ),
    ],
  });
