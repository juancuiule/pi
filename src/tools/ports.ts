// The agent's port publishing: expose_port puts a port its service listens on inside the sandbox at a
// random localhost URL the person can open in their browser. Every call waits for the person's decision
// whatever the approval policy (see withPersonApproval); close_port only reduces exposure, so it is not
// gated. The section lists the ports currently open.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";

import { withPersonApproval } from "../approvals.ts";
import { SandboxDoc } from "../sandbox/sandbox.ts";

/** The Seat-side ops the extension's tools call; wired per-conversation by Agents.layer. */
export interface PortsHandler {
  /** Publish `input.port` on a random host loopback port; resolves with its URL. */
  expose(
    conversationId: ConversationId,
    input: { readonly port: number; readonly label?: string },
    signal: AbortSignal | undefined
  ): Promise<{ readonly url: string }>;
  /** Stop publishing `port`; a no-op when it is not open. */
  close(
    conversationId: ConversationId,
    port: number,
    signal: AbortSignal | undefined
  ): Promise<void>;
}

export const portsExtension = (handler: PortsHandler): Extension =>
  defineExtension({
    name: "ports",
    sections: [
      section("ports", async (input, context) => {
        const doc = await input.read.snapshot(
          SandboxDoc,
          input.conversationId,
          context
        );
        const open = doc?.sandbox?.ports ?? [];
        return [
          "expose_port(port) publishes a port your service listens on at a random localhost URL the person can open in their browser — it always asks them first. Start the service before exposing it.",
          ...(open.length === 0
            ? []
            : [
                "Ports open to the person:",
                ...open.map(
                  ({ port, label, url }) =>
                    `- ${label ?? `port ${port}`}: ${url}`
                ),
              ]),
        ].join("\n");
      }),
    ],
    tools: [
      withPersonApproval(
        defineTool({
          name: "expose_port",
          description: [
            "Publish a port your service listens on inside the sandbox at a random localhost URL the person can open in their browser.",
            "The person approves every call, whatever the approval policy.",
            "It stays open until the person closes it or the sandbox is replaced.",
            "Start the service on the port first.",
          ].join(" "),
          parameters: Type.Object({
            port: Type.Integer({
              minimum: 1,
              maximum: 65_535,
              description:
                "The port your service listens on inside the sandbox",
            }),
            label: Type.Optional(
              Type.String({
                description: "A short name the person sees, like 'dev server'",
              })
            ),
            reason: Type.Optional(
              Type.String({ description: "Why, shown to the person" })
            ),
          }),
          replay: "safe",
          execute: async ({ port, label }, api, context) => {
            const { url } = await handler.expose(
              api.conversationId,
              { port, ...(label === undefined ? {} : { label }) },
              context.abortSignal
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Port ${port} is now open at ${url} — share this link with the person.`,
                },
              ],
              details: { url },
            };
          },
        })
      ),
      defineTool({
        name: "close_port",
        description:
          "Stop publishing a port: its localhost URL stops working and the person can no longer reach the service through it.",
        parameters: Type.Object({
          port: Type.Integer({
            minimum: 1,
            maximum: 65_535,
            description: "The port to stop publishing",
          }),
        }),
        replay: "safe",
        execute: async ({ port }, api, context) => {
          await handler.close(api.conversationId, port, context.abortSignal);
          return {
            content: [{ type: "text", text: `Port ${port} is closed.` }],
          };
        },
      }),
    ],
  });
