// Per-conversation metadata the console needs after a restart: title, sandbox choice and timestamps.
// The doc survives the conversation's scope, so the server can list and describe conversations that
// are no longer live.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";

import type { SandboxChoice } from "./sandbox/sandbox.ts";

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type, and
// interfaces have no index signature.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type ConversationMeta = {
  readonly title: string;
  readonly sandbox: SandboxChoice;
  readonly createdAt: number;
  /** Set by `end()`; an ended conversation is never resumable. */
  readonly endedAt?: number;
};

export interface StoredConversation {
  readonly id: ConversationId;
  readonly meta: ConversationMeta;
}

export const MetaDoc = defineDoc<{ meta?: ConversationMeta }>({
  kind: "app.meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
