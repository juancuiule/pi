// Accounts and sessions: who a request is. Ownership of Conversations is the Agents' (ConversationMeta.owner);
// this service only answers which User a session token belongs to.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Clock, Context, Effect, Layer } from "effect";

import {
  InvalidAccount,
  InvalidCredentials,
  SetupClosed,
  TooManyAttempts,
  Unauthorized,
} from "../errors.ts";
import { decoyHash, hashPassword, verifyPassword } from "./password.ts";
import { sqliteRecords } from "./store.ts";
import type { AuthRecords } from "./store.ts";
import { nameProblem, passwordProblem } from "./user.ts";
import type { User, UserId } from "./user.ts";

export { SESSION_COOKIE } from "./user.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Failed sign-ins a name gets before it is blocked, and how long the first block lasts; each further one doubles. */
const FREE_FAILURES = 5;
const FIRST_BLOCK_MS = 30_000;
const MAX_BLOCK_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const checked = (name: string, password: string) => {
  const problem = nameProblem(name) ?? passwordProblem(password);
  return problem === undefined
    ? Effect.void
    : Effect.fail(new InvalidAccount({ reason: problem }));
};

/** A signed-in User and the session token to set as the cookie. */
export interface SignedIn {
  readonly user: User;
  readonly token: string;
}

export class Auth extends Context.Service<
  Auth,
  {
    /** Who the token signs in, and whether first-run setup is open (no account exists yet). */
    state(
      token?: string
    ): Effect.Effect<{ readonly user?: User; readonly setup: boolean }>;
    /** The User of a live session. */
    authenticate(token: string): Effect.Effect<User, Unauthorized>;
    login(
      name: string,
      password: string
    ): Effect.Effect<SignedIn, InvalidCredentials | TooManyAttempts>;
    /** Create the first account and sign it in; `SetupClosed` once any account exists. */
    setup(
      name: string,
      password: string
    ): Effect.Effect<SignedIn, SetupClosed | InvalidAccount>;
    logout(token: string): Effect.Effect<void>;
    /** Add an account (the CLI, tests); it signs nobody in. */
    addUser(
      name: string,
      password: string
    ): Effect.Effect<User, InvalidAccount>;
    /** Replace an account's password; its sessions end. */
    setPassword(
      name: string,
      password: string
    ): Effect.Effect<void, InvalidAccount>;
    /** Every account, oldest first. */
    readonly users: Effect.Effect<readonly User[]>;
  }
>()("effect-pi/Auth") {
  static readonly layer = (options: { readonly records: AuthRecords }) =>
    Layer.effect(
      Auth,
      Effect.sync(() => {
        const { records } = options;
        // Per name, in memory: a restart forgets them, which only ever lets a person in sooner.
        const failures = new Map<
          string,
          { count: number; blockedUntil: number }
        >();

        // Names are the attacker's to choose, so the map is bounded: past MAX_TRACKED, names no longer blocked go.
        const forgetStale = (now: number) => {
          if (failures.size <= MAX_TRACKED) {
            return;
          }
          for (const [name, entry] of failures) {
            if (entry.blockedUntil <= now) {
              failures.delete(name);
            }
          }
        };

        const newAccount = Effect.fnUntraced(function* (
          name: string,
          password: string
        ) {
          yield* checked(name, password);
          const passwordHash = yield* Effect.promise(() =>
            hashPassword(password)
          );
          return {
            user: { id: randomUUID() as UserId, name },
            passwordHash,
            createdAt: yield* Clock.currentTimeMillis,
          };
        });

        const signIn = Effect.fnUntraced(function* (user: User) {
          const now = yield* Clock.currentTimeMillis;
          records.prune(now);
          const token = randomBytes(32).toString("base64url");
          records.insertSession({
            tokenHash: tokenHash(token),
            userId: user.id,
            createdAt: now,
            expiresAt: now + SESSION_TTL_MS,
          });
          return { user, token } satisfies SignedIn;
        });

        const login = Effect.fn("Auth.login")(function* (
          name: string,
          password: string
        ) {
          const key = name.toLowerCase();
          const now = yield* Clock.currentTimeMillis;
          const blocked = failures.get(key);
          if (blocked !== undefined && blocked.blockedUntil > now) {
            return yield* new TooManyAttempts({
              retryAfterMs: blocked.blockedUntil - now,
            });
          }
          // Charged before the slow check, in the same synchronous step as the read above, so a burst of parallel
          // guesses counts every one of them; a right password takes the charge back.
          const count = (blocked?.count ?? 0) + 1;
          const over = count - FREE_FAILURES;
          failures.set(key, {
            count,
            blockedUntil:
              over < 0
                ? 0
                : now + Math.min(FIRST_BLOCK_MS * 2 ** over, MAX_BLOCK_MS),
          });
          forgetStale(now);
          const account = records.byName(key);
          // An unknown name is checked against a decoy, so timing does not tell which names exist.
          const ok = yield* Effect.promise(async () =>
            verifyPassword(
              password,
              account?.passwordHash ?? (await decoyHash())
            )
          );
          if (account === undefined || !ok) {
            return yield* new InvalidCredentials();
          }
          failures.delete(key);
          return yield* signIn(account.user);
        });

        const setup = Effect.fn("Auth.setup")(function* (
          name: string,
          password: string
        ) {
          if (records.users().length > 0) {
            return yield* new SetupClosed();
          }
          const account = yield* newAccount(name, password);
          if (!records.insertUser(account, { onlyFirst: true })) {
            return yield* new SetupClosed();
          }
          return yield* signIn(account.user);
        });

        const addUser = Effect.fn("Auth.addUser")(function* (
          name: string,
          password: string
        ) {
          const account = yield* newAccount(name, password);
          if (!records.insertUser(account)) {
            return yield* new InvalidAccount({
              reason: `An account named ${name} exists already.`,
            });
          }
          return account.user;
        });

        const setPassword = Effect.fn("Auth.setPassword")(function* (
          name: string,
          password: string
        ) {
          yield* checked(name, password);
          const hash = yield* Effect.promise(() => hashPassword(password));
          if (!records.setPassword(name, hash)) {
            return yield* new InvalidAccount({
              reason: `No account is named ${name}.`,
            });
          }
        });

        const session = (token: string) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return token === ""
              ? undefined
              : records.session(tokenHash(token), now);
          });

        return Auth.of({
          state: (token) =>
            Effect.gen(function* () {
              const user =
                token === undefined ? undefined : yield* session(token);
              return {
                ...(user === undefined ? {} : { user }),
                setup: records.users().length === 0,
              };
            }),
          authenticate: (token) =>
            Effect.flatMap(session(token), (user) =>
              user === undefined
                ? Effect.fail(new Unauthorized())
                : Effect.succeed(user)
            ),
          login,
          setup,
          logout: (token) =>
            Effect.sync(() => records.deleteSession(tokenHash(token))),
          addUser,
          setPassword,
          users: Effect.sync(() =>
            records.users().map((account) => account.user)
          ),
        });
      })
    );

  /** The tables in a SQLite file, created if missing. */
  static readonly local = (options: { readonly database: string }) =>
    Layer.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => sqliteRecords(options.database)),
        (records) => Effect.sync(() => records.close())
      ).pipe(Effect.map((records) => Auth.layer({ records })))
    );

  /** Empty tables in memory; for tests. */
  static readonly temporary = () => Auth.local({ database: ":memory:" });
}
