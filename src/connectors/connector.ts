// A personal connector: a third-party service each User connects with their own account (Nextcloud first; OpenProject
// and Google Calendar are meant to follow, #81 and #83). The pieces every one shares live here: how a credential is
// obtained and revoked, how a tool finds the credential of the conversation it runs for, and how a tool's access —
// read or write — decides its gating. Decisions: docs/adr/0010-personal-connectors.md.
import type { Context } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
  Extension,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";

import { withApproval } from "../approvals.ts";
import type { ConnectorAccount, ConnectorCredential } from "./vault.ts";

/** A connector refusing a credential or a step of its login flow; `message` is for the person, secret-free. */
export class ConnectorError extends Error {
  override readonly name: string = "ConnectorError";
}

/** A browser login the server started: the person opens `loginUrl`, the server polls until it yields a credential. */
export interface LoginFlow {
  readonly loginUrl: string;
  readonly expiresAt: number;
  /** The credential once the person has logged in, `undefined` while they have not; throws `ConnectorError`. */
  poll(signal?: AbortSignal): Promise<ConnectorCredential | undefined>;
}

/**
 * The credential lookup a connector's tools get: the credential of the User who owns the conversation a call runs
 * for (a subagent's is its parent's owner), `undefined` when they have not connected.
 */
export type CredentialLookup = (
  api: Pick<ToolExecutionApi, "conversationId" | "snapshot">,
  context: Context
) => Promise<ConnectorCredential | undefined>;

/** The same for a prompt section, which has the conversation id and a document reader. */
export type SectionLookup = (
  input: { readonly conversationId: ToolExecutionApi["conversationId"] } & {
    readonly read: Pick<ToolExecutionApi, "snapshot">;
  },
  context: Context
) => Promise<
  { readonly account: ConnectorAccount; readonly unreadable?: true } | undefined
>;

export interface PersonalConnector {
  /** `[a-z0-9-]+`; the API path segment and the vault's key. */
  readonly id: string;
  readonly title: string;
  /** The service this server's Users connect to; one per server, set by the operator. */
  readonly url: string;
  /** Check `login` and `password` with the service and return what to store (possibly an exchanged secret). */
  connect(
    input: { readonly login: string; readonly password: string },
    signal?: AbortSignal
  ): Promise<ConnectorCredential>;
  /** Start a browser login, when the service has one. */
  startLogin?(signal?: AbortSignal): Promise<LoginFlow>;
  /** Invalidate a credential at the service on disconnect; best effort, failures are ignored. */
  revoke?(credential: ConnectorCredential): Promise<void>;
  /** The agent's tools and prompt section; the tools find the owner's credential through `lookup`. */
  extension(lookups: {
    readonly credential: CredentialLookup;
    readonly section: SectionLookup;
  }): Extension;
}

/**
 * A connector's tool, gated by what it does. `read` tools run under every policy and may rerun after a crash
 * (`replay: "safe"`); `write` tools wait for the person under `ask` (`withApproval`) and never rerun on their own.
 * Every tool of a personal connector goes through this, so gating is decided once, where the tool is defined.
 */
export const connectorTool = <TParameters extends TSchema>(
  access: "read" | "write",
  tool: ToolRegistration<TParameters>
): ToolRegistration =>
  access === "read"
    ? (defineTool({ ...tool, replay: "safe" }) as unknown as ToolRegistration)
    : withApproval(
        defineTool({
          ...tool,
          replay: "unsafe",
        }) as unknown as ToolRegistration
      );
