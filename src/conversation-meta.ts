// Per-conversation metadata the console needs after a restart: title and timestamps. The doc survives every Seat,
// so the server can list and describe Conversations that are paused or archived.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";

import type { SandboxChoice } from "./sandbox/sandbox.ts";
import type { SoftwareId } from "./sandbox/software.ts";

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type, and
// interfaces have no index signature.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type ConversationMeta = {
  readonly title: string;
  readonly createdAt: number;
  /** Set by Archive, removed by unarchiving. */
  readonly archivedAt?: number;
};

/** A stored Conversation: its metadata and its Workspace's Level and Software. */
export interface StoredConversation {
  readonly id: ConversationId;
  readonly meta: ConversationMeta;
  readonly level: SandboxChoice;
  readonly software: readonly SoftwareId[];
}

export const MetaDoc = defineDoc<{ meta?: ConversationMeta }>({
  kind: "app.meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
