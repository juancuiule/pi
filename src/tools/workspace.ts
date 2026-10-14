// The agent's Upgrade: a prompt section that tells the agent what machine it has, and a tool that raises its conversation's Workspace to a higher Level when a task needs a shell or
// a desktop. Under the `ask` approval policy the person approves it first; when there is no room, it waits until the
// person frees some (see Capacity), and a Stop or a cancelled wait ends it with an error the model can read.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";

import { withApproval } from "../approvals.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import { WorkspaceDoc } from "../workspaces/workspaces.ts";

/** What the agent is told about its machine, by its Workspace's Level. */
export const workspaceSection = (level: SandboxChoice): string => {
  switch (level) {
    case "none": {
      return [
        "You have no machine yet: you cannot write files or run anything.",
        'When the user asks you to create, write, save or run a file, a script or a program, first call upgrade_workspace with level "shell", then write and run it there with your file and shell tools. Use level "desktop" when a task needs a graphical desktop.',
        "Do not answer such a request by pasting the code in your reply.",
      ].join("\n");
    }
    case "shell": {
      return 'You have a Linux shell with file tools; your files are in /workspace. When a task needs a graphical desktop, call upgrade_workspace with level "desktop".';
    }
    case "desktop": {
      return "You have a Linux desktop with a shell and file tools; your files are in /workspace.";
    }
    default: {
      throw new TypeError(`Unknown Level: ${level satisfies never}`);
    }
  }
};

/** Raise `conversationId`'s Workspace to `level`; resolves with a sentence for the model, rejects on failure. */
export type UpgradeWorkspace = (
  conversationId: ConversationId,
  level: "shell" | "desktop",
  signal: AbortSignal | undefined
) => Promise<string>;

export const workspaceExtension = (upgrade: UpgradeWorkspace): Extension =>
  defineExtension({
    name: "workspace",
    sections: [
      section("workspace", async (input, context) => {
        const doc = await input.read.snapshot(
          WorkspaceDoc,
          input.conversationId,
          context
        );
        return workspaceSection(doc?.level ?? "none");
      }),
    ],
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
