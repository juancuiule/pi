// The personal connectors this server offers and each User's connection to them. The console's Settings → Connections
// lists, connects and disconnects them (`/api/connectors`); the Agents layer installs each connector's extension,
// whose tools look up the conversation owner's credential here. A server without connectors configured has no
// extensions and an empty list. Credentials stay in the vault: nothing in this module logs or returns a secret.
import type { Extension } from "@earendil-works/pi-durable";
import { Clock, Context, Effect, Layer } from "effect";

import type { UserId } from "../auth/user.ts";
import { conversationOwner } from "../conversation-meta.ts";
import { ConnectorNotFound, ConnectorRefused } from "../errors.ts";
import { ConnectorError } from "./connector.ts";
import type { LoginFlow, PersonalConnector } from "./connector.ts";
import { generateSecretKey, parseSecretKey, sqliteVault } from "./vault.ts";
import type { ConnectorAccount, CredentialVault } from "./vault.ts";

/** A connector as one User sees it. */
export interface ConnectorStatus {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** Whether the connector has a browser login (else only a login and password form). */
  readonly loginFlow: boolean;
  readonly connection?: {
    readonly account: ConnectorAccount;
    readonly connectedAt: number;
    /** Sealed under another CONNECTOR_SECRET_KEY: the tools cannot use it, the person must connect again. */
    readonly unreadable: boolean;
  };
}

export type LoginPoll =
  | { readonly status: "pending" }
  | { readonly status: "connected"; readonly connector: ConnectorStatus };

const messageOf = (error: unknown): string =>
  error instanceof ConnectorError
    ? error.message
    : "The service could not be reached.";

/** What `Connectors` offers; `makeConnectors` builds it. */
export interface ConnectorsService {
  /** One extension per configured connector, for the Agents layer to install at every Level. */
  readonly extensions: readonly Extension[];
  list(owner: UserId): Effect.Effect<readonly ConnectorStatus[]>;
  /** Check the credentials with the service and keep what it says to keep. */
  connect(
    owner: UserId,
    id: string,
    input: { readonly login: string; readonly password: string }
  ): Effect.Effect<ConnectorStatus, ConnectorNotFound | ConnectorRefused>;
  /** Forget the credential and revoke it at the service (best effort). Idempotent. */
  disconnect(owner: UserId, id: string): Effect.Effect<void, ConnectorNotFound>;
  /** Start a browser login; a later `poll` finishes it. Starting again replaces an unfinished one. */
  startLogin(
    owner: UserId,
    id: string
  ): Effect.Effect<
    { readonly loginUrl: string; readonly expiresAt: number },
    ConnectorNotFound | ConnectorRefused
  >;
  /** Ask the service once whether the person finished the login started by `startLogin`. */
  pollLogin(
    owner: UserId,
    id: string
  ): Effect.Effect<LoginPoll, ConnectorNotFound | ConnectorRefused>;
}

const loginKey = (owner: UserId, id: string) => `${owner}\u0000${id}`;

const refused = (id: string) => (error: unknown) =>
  new ConnectorRefused({ connector: id, message: messageOf(error) });

/** The service over `connectors` and `vault`. */
const makeConnectors = (options: {
  readonly connectors: readonly PersonalConnector[];
  readonly vault: CredentialVault;
}): ConnectorsService => {
  const { vault } = options;
  const byId = new Map(
    options.connectors.map((connector) => [connector.id, connector])
  );
  // At most one unfinished browser login per User and connector; they expire with the service's own token.
  const logins = new Map<string, LoginFlow>();

  const find = (id: string) => {
    const connector = byId.get(id);
    return connector === undefined
      ? Effect.fail(new ConnectorNotFound({ connector: id }))
      : Effect.succeed(connector);
  };

  const statusOf = (
    owner: UserId,
    connector: PersonalConnector
  ): ConnectorStatus => {
    const stored = vault.get(owner, connector.id);
    return {
      id: connector.id,
      title: connector.title,
      url: connector.url,
      loginFlow: connector.startLogin !== undefined,
      ...(stored === undefined
        ? {}
        : {
            connection: {
              account: stored.account,
              connectedAt: stored.connectedAt,
              unreadable: "unreadable" in stored,
            },
          }),
    };
  };

  const extensions = options.connectors.map((connector) =>
    connector.extension({
      credential: async (api, context) => {
        const owner = await conversationOwner(api, api.conversationId, context);
        const stored =
          owner === undefined ? undefined : vault.get(owner, connector.id);
        return stored === undefined || "unreadable" in stored
          ? undefined
          : { account: stored.account, secret: stored.secret };
      },
      section: async (input, context) => {
        const owner = await conversationOwner(
          input.read,
          input.conversationId,
          context
        );
        const stored =
          owner === undefined ? undefined : vault.get(owner, connector.id);
        if (stored === undefined) {
          return;
        }
        return "unreadable" in stored
          ? { account: stored.account, unreadable: true }
          : { account: stored.account };
      },
    })
  );

  return {
    extensions,
    list: (owner) =>
      Effect.sync(() =>
        options.connectors.map((connector) => statusOf(owner, connector))
      ),
    connect: (owner, id, input) =>
      Effect.gen(function* () {
        const connector = yield* find(id);
        const credential = yield* Effect.tryPromise({
          try: (signal) => connector.connect(input, signal),
          catch: refused(id),
        });
        const at = yield* Clock.currentTimeMillis;
        vault.put(owner, id, credential, at);
        return statusOf(owner, connector);
      }),
    disconnect: (owner, id) =>
      Effect.gen(function* () {
        const connector = yield* find(id);
        const stored = vault.get(owner, id);
        logins.delete(loginKey(owner, id));
        vault.remove(owner, id);
        if (
          stored !== undefined &&
          !("unreadable" in stored) &&
          connector.revoke !== undefined
        ) {
          const { revoke } = connector;
          yield* Effect.promise(() =>
            revoke({ account: stored.account, secret: stored.secret })
              .then((): void => undefined)
              .catch((): void => undefined)
          );
        }
      }),
    startLogin: (owner, id) =>
      Effect.gen(function* () {
        const connector = yield* find(id);
        const { startLogin } = connector;
        if (startLogin === undefined) {
          return yield* new ConnectorRefused({
            connector: id,
            message: `${connector.title} has no browser login; use a login and password.`,
          });
        }
        const flow = yield* Effect.tryPromise({
          try: (signal) => startLogin(signal),
          catch: refused(id),
        });
        logins.set(loginKey(owner, id), flow);
        return { loginUrl: flow.loginUrl, expiresAt: flow.expiresAt };
      }),
    pollLogin: (owner, id) =>
      Effect.gen(function* () {
        const connector = yield* find(id);
        const key = loginKey(owner, id);
        const flow = logins.get(key);
        const now = yield* Clock.currentTimeMillis;
        if (flow === undefined || flow.expiresAt <= now) {
          logins.delete(key);
          return yield* new ConnectorRefused({
            connector: id,
            message: "The login expired or was never started; start it again.",
          });
        }
        const credential = yield* Effect.tryPromise({
          try: (signal) => flow.poll(signal),
          catch: (error) => {
            logins.delete(key);
            return refused(id)(error);
          },
        });
        if (credential === undefined) {
          return { status: "pending" } as const;
        }
        logins.delete(key);
        vault.put(owner, id, credential, now);
        return {
          status: "connected",
          connector: statusOf(owner, connector),
        } as const;
      }),
  };
};

/** Nothing configured: an empty list, every id unknown, nothing stored. */
const nothing = (): undefined => undefined;
const emptyVault: CredentialVault = {
  get: nothing,
  all: () => new Map(),
  put: nothing,
  remove: () => false,
  close: nothing,
};

/** For a server without connectors, and for an API layer built without the service (tests). */
export const noConnectors: ConnectorsService = makeConnectors({
  connectors: [],
  vault: emptyVault,
});

export class Connectors extends Context.Service<
  Connectors,
  ConnectorsService
>()("effect-pi/connectors/Connectors") {
  static readonly layer = (options: {
    readonly connectors: readonly PersonalConnector[];
    readonly vault: CredentialVault;
  }) => Layer.sync(Connectors, () => makeConnectors(options));

  /**
   * Connectors over the `connector_credentials` table of a SQLite file. `secretKey` (CONNECTOR_SECRET_KEY) is
   * required as soon as one connector is configured; with none, nothing is opened and the list is empty.
   */
  static readonly local = (options: {
    readonly database: string;
    readonly secretKey: string | undefined;
    readonly connectors: readonly PersonalConnector[];
  }) => {
    const { secretKey, connectors } = options;
    if (connectors.length === 0) {
      return Connectors.none;
    }
    // Thrown while the layers are assembled, so a missing key stops startup before anything serves.
    if (secretKey === undefined) {
      throw new Error(
        `CONNECTOR_SECRET_KEY is required with ${connectors.map((c) => c.title).join(", ")} configured (generate one with \`openssl rand -base64 32\`; \`pnpm nextcloud:up\` writes one to .env)`
      );
    }
    const key = parseSecretKey(secretKey);
    return Layer.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => sqliteVault(options.database, key)),
        (vault) => Effect.sync(() => vault.close())
      ).pipe(Effect.map((vault) => Connectors.layer({ connectors, vault })))
    );
  };

  /** No connectors: no extensions, an empty list. */
  static readonly none: Layer.Layer<Connectors> = Layer.sync(
    Connectors,
    () => noConnectors
  );

  /** In memory under a random key, for tests. */
  static readonly temporary = (connectors: readonly PersonalConnector[]) =>
    Connectors.local({
      database: ":memory:",
      secretKey: generateSecretKey(),
      connectors,
    });
}
