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
import { SandboxDoc } from "../sandbox/sandbox.ts";
import { normalize, offered, SOFTWARE } from "../sandbox/software.ts";
import type { SoftwareId } from "../sandbox/software.ts";
import { WorkspaceDoc } from "../workspaces/workspaces.ts";

/** The `upgrade_workspace` tool's name; a subagent's agent has it removed so it cannot swap the shared sandbox. */
export const UPGRADE_WORKSPACE = "upgrade_workspace";

// Both sandbox images have agent-browser and Google Chrome (docker/sandbox/shell.Dockerfile).
const BROWSER =
  "To use a website — open pages, click, fill forms, read what search snippets do not show — use `agent-browser`, which drives Google Chrome; load the `agent-browser` skill first.";

// What both sandbox images have (docker/sandbox/shell.Dockerfile), so the agent does not probe for it.
const BASE = [
  "Installed: python3 (also `python`) with `pip` and `uv`, git, curl, wget, jq, ripgrep (`rg`), sqlite3, zip and unzip, Google Chrome with `agent-browser`. `pip install` works system-wide; `uvx <tool>` runs a Python command-line tool from PyPI without installing it.",
  "For anything else, run `apt-get update` before `apt-get install -y <package>`. What you install yourself is gone when this machine is replaced (an upgrade, a pause); software added with upgrade_workspace stays.",
].join("\n");

const levelSection = (level: SandboxChoice): string => {
  switch (level) {
    case "none": {
      return [
        "You have no machine yet: you cannot write files or run anything.",
        "When the user asks for something to see or use — a report, a chart, a dashboard, a prototype — call artifact_create with its self-contained HTML; the person sees the page beside the chat.",
        'When the user asks for a file to keep or code to run — a document, a script, a program — first call upgrade_workspace with level "shell", then write and run it there with your file and shell tools. Use level "desktop" when a task needs a graphical desktop.',
        "Do not answer either kind of request by pasting the code or the page in your reply.",
      ].join("\n");
    }
    case "shell": {
      return [
        'You have a Linux shell with file tools; your files are in /workspace. When a task needs a graphical desktop, call upgrade_workspace with level "desktop".',
        BASE,
        BROWSER,
      ].join("\n");
    }
    case "desktop": {
      return [
        "You have a Linux desktop with a shell and file tools; your files are in /workspace.",
        BASE,
        BROWSER,
        "To operate the desktop's apps, use `agent-desktop`, which reads them as text through the accessibility tree; load the `agent-desktop` skill first, and prefer it over screenshots and pixel coordinates.",
      ].join("\n");
    }
    default: {
      throw new TypeError(`Unknown Level: ${level satisfies never}`);
    }
  }
};

// The console's composer writes `@path` mentions (web/lib/workspace-mentions.ts); the text reaches the model as typed.
const MENTIONS =
  'In the person\'s messages, `@path` names a path under /workspace (`@"path"` when it contains spaces); only the path is sent, so read the file yourself when you need it.';

/** What the agent is told about its machine, by its Workspace's Level and Software. */
export const workspaceSection = (
  level: SandboxChoice,
  recorded: readonly SoftwareId[] = []
): string => {
  // A Workspace may have recorded an entry its base image now has.
  const software = normalize(recorded);
  return [
    levelSection(level),
    ...(level === "none" ? [] : [MENTIONS]),
    ...(software.length === 0
      ? []
      : [
          "Installed beyond the base system:",
          ...software.map((id) => `- ${SOFTWARE[id].prompt}`),
        ]),
  ].join("\n");
};

/** What the agent asks `upgrade_workspace` for: a higher Level, catalog Software, or both. */
export interface WorkspaceRequest {
  readonly level?: "shell" | "desktop" | undefined;
  readonly software?: readonly SoftwareId[] | undefined;
}

/** Upgrade `conversationId`'s Workspace; resolves with a sentence for the model, rejects on failure. */
export type UpgradeWorkspace = (
  conversationId: ConversationId,
  request: WorkspaceRequest,
  signal: AbortSignal | undefined
) => Promise<string>;

// What the agent can add on this host: every Level's, since the tool can raise the Level in the same call.
const AVAILABLE = offered("desktop");

const softwareParameter = () =>
  Type.Array(Type.Union(AVAILABLE.map((id) => Type.Literal(id))), {
    description: `Catalog software to install for good: ${AVAILABLE.map(
      (id) => `\`${id}\` (${SOFTWARE[id].label}: ${SOFTWARE[id].description})`
    ).join(", ")}`,
  });

export const workspaceExtension = (upgrade: UpgradeWorkspace): Extension =>
  defineExtension({
    name: "workspace",
    sections: [
      section("workspace", async (input, context) => {
        // A task-owned conversation works in its owner's machine: its own WorkspaceDoc stays "none".
        const sandbox = await input.read.snapshot(
          SandboxDoc,
          input.conversationId,
          context
        );
        const owner = sandbox?.owner;
        const doc = await input.read.snapshot(
          WorkspaceDoc,
          owner === undefined
            ? input.conversationId
            : (Number(owner) as ConversationId),
          context
        );
        return workspaceSection(doc?.level ?? "none", doc?.software);
      }),
    ],
    tools: [
      withApproval(
        defineTool({
          name: UPGRADE_WORKSPACE,
          description:
            "Get a bigger machine for this conversation, or add software to it. `level`: `shell` adds a Linux shell with file tools, `desktop` adds a graphical desktop on top. `software`: programs from this server's catalog, which stay installed in this conversation's machine from then on; the first time a combination is used its image is built, which can take a few minutes. Pass either or both. Your files in /workspace carry over, and so does added software; what you install yourself with apt or pip does not. Use it only when the task needs it, and say why.",
          parameters: Type.Object({
            level: Type.Optional(
              Type.Union([Type.Literal("shell"), Type.Literal("desktop")], {
                description: "The Level to raise the workspace to",
              })
            ),
            software: Type.Optional(softwareParameter()),
            reason: Type.String({
              description: "Why the task needs it, shown to the person",
            }),
          }),
          // Creates a Sandbox and takes Capacity: never rerun blindly after a crash.
          replay: "unsafe",
          execute: async ({ level, software }, api, context) => ({
            content: [
              {
                type: "text",
                text: await upgrade(
                  api.conversationId,
                  { level, software },
                  context.abortSignal
                ),
              },
            ],
          }),
        })
      ),
    ],
  });
