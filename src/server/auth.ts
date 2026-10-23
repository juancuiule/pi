// Who a request is, and which Conversations it may touch. `Authentication` (declared in api.ts) runs before every
// endpoint outside the `auth` group; the shell's WebSocket route, outside the HttpApi, calls the same two checks.
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Layer, Redacted } from "effect";
import type { Cookies } from "effect/http";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Agents } from "../agents/agents.ts";
import { TrustedDomains } from "../artifacts/domains.ts";
import { Auth, SESSION_COOKIE, SESSION_TTL_MS } from "../auth/auth.ts";
import type { User, UserId } from "../auth/user.ts";
import { ConversationNotFound } from "../errors.ts";
import { Api, Authentication, CurrentUser } from "./api.ts";

/** A segment or query value as the router could read it: a number when `Number` makes one of it. */
const asNumber = (raw: string): number | undefined => {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const number = Number(value);
  return value.trim() === "" || !Number.isFinite(number) ? undefined : number;
};

/**
 * Every Conversation id a request URL names: the segment after any `conversations` segment, and every
 * `conversation` query value. Read loosely on purpose — `+1`, `%31` or `1.0` may decode to Conversation 1 in an
 * endpoint's params, so anything that reads as a number is checked as that number.
 */
export const conversationsNamed = (url: string): readonly number[] => {
  const parsed = new URL(url, "http://localhost");
  const segments = parsed.pathname.split("/");
  const named: number[] = [];
  for (const [at, segment] of segments.entries()) {
    const next = segments[at + 1];
    const id = next === undefined ? undefined : asNumber(next);
    if (segment === "conversations" && id !== undefined) {
      named.push(id);
    }
  }
  for (const value of parsed.searchParams.getAll("conversation")) {
    const id = asNumber(value);
    if (id !== undefined) {
      named.push(id);
    }
  }
  return named;
};

/**
 * Fail `ConversationNotFound` unless `owner` owns Conversation `id` (a subagent through its root). Unknown ids and
 * other people's read the same.
 */
export const requireOwner = (id: number, owner: UserId) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const found = Number.isInteger(id)
      ? yield* agents.ownerOf(id as ConversationId)
      : undefined;
    if (found !== owner) {
      return yield* new ConversationNotFound({ id });
    }
  }).pipe(Effect.catchTag("AgentError", Effect.die));

/** The User of a request and its URL's Conversations checked against them; the shell route's whole gate. */
export const authorize = (token: string, url: string) =>
  Effect.gen(function* () {
    const user = yield* (yield* Auth).authenticate(token);
    yield* Effect.forEach(conversationsNamed(url), (id) =>
      requireOwner(id, user.id)
    );
    return user;
  });

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth;
    const agents = yield* Agents;
    return Authentication.of({
      session: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const user = yield* authorize(
            Redacted.value(credential),
            request.url
          ).pipe(
            Effect.provideService(Auth, auth),
            Effect.provideService(Agents, agents)
          );
          return yield* Effect.provideService(httpEffect, CurrentUser, user);
        }),
    });
  })
);

// Plain http on loopback: a `secure` cookie would not be stored by every browser on http://localhost.
const cookieOptions = {
  secure: false,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} satisfies Cookies.Cookie["options"];

const setSession = (token: string, maxAgeMs: number) =>
  HttpApiBuilder.securitySetCookie(Authentication.security.session, token, {
    ...cookieOptions,
    maxAge: `${Math.floor(maxAgeMs / 1000)} seconds`,
  });

const tokenOf = (request: HttpServerRequest.HttpServerRequest) =>
  request.cookies[SESSION_COOKIE];

/**
 * The `auth` group. Building it adopts, for the oldest account, whatever predates accounts (Conversations and
 * Trusted domains without an owner): setup does it for the first account, and doing it again at every start
 * finishes an adoption a crash interrupted. Both adoptions are idempotent.
 */
export const AuthHandlers = HttpApiBuilder.group(
  Api,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* Auth;
    const agents = yield* Agents;
    const domains = yield* TrustedDomains;

    const adopt = (user: User) =>
      Effect.gen(function* () {
        const adopted = yield* agents.adopt(user.id);
        yield* domains.adopt(user.id);
        if (adopted > 0) {
          yield* Effect.logInfo(
            `${user.name} adopted ${adopted} conversation(s) from before accounts`
          );
        }
      }).pipe(Effect.catchTag("AgentError", Effect.die));

    const [oldest] = yield* auth.users;
    if (oldest !== undefined) {
      yield* adopt(oldest);
    }

    return handlers
      .handle("state", () =>
        Effect.gen(function* () {
          return yield* auth.state(
            tokenOf(yield* HttpServerRequest.HttpServerRequest)
          );
        })
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const { user, token } = yield* auth.login(
            payload.name,
            payload.password
          );
          yield* setSession(token, SESSION_TTL_MS);
          return user;
        })
      )
      .handle("setup", ({ payload }) =>
        Effect.gen(function* () {
          const { user, token } = yield* auth.setup(
            payload.name,
            payload.password
          );
          yield* adopt(user);
          yield* setSession(token, SESSION_TTL_MS);
          return user;
        })
      )
      .handle("logout", () =>
        Effect.gen(function* () {
          const token = tokenOf(yield* HttpServerRequest.HttpServerRequest);
          if (token !== undefined) {
            yield* auth.logout(token);
          }
          yield* setSession("", 0);
        })
      );
  })
);
