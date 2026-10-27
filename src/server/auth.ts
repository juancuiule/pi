// Who a request is, and which Conversations it may touch. `Authentication` (declared in api.ts) runs before every
// endpoint outside the `auth` group; the shell's WebSocket route, outside the HttpApi, calls the same two checks.
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Layer, Redacted } from "effect";
import type { Cookies } from "effect/http";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Agents } from "../agents/agents.ts";
import { TrustedDomains } from "../artifacts/domains.ts";
import { Auth, SESSION_COOKIE, SESSION_TTL_MS } from "../auth/auth.ts";
import type { User, UserId } from "../auth/user.ts";
import { ConversationNotFound } from "../errors.ts";
import { Api, Authentication, CurrentUser } from "./api.ts";
import { viaHttpsPublicUrl } from "./loopback.ts";

/** A param or query value as an endpoint's schema could read it: a number when `Number` makes one of it. */
const asNumber = (value: string | undefined): number | undefined => {
  const number = Number(value);
  return value === undefined || value.trim() === "" || !Number.isFinite(number)
    ? undefined
    : number;
};

/** A route template addressed by a Conversation: `/api/conversations/:id` and everything under it. */
const BY_CONVERSATION = /\/conversations\/:id(?:\/|$)/u;

/**
 * Every Conversation id a matched request names: its `:id` param when the route's template sits under
 * `conversations/:id`, and every `conversation` search param. Read from what the router matched and decoded, never
 * from the raw URL: the router also matches `/api/Conversations/2`, `/api/%63onversations/2` and
 * `/api/conversations//2`, and a URL reader that missed one of them would wave the request through. Values are read
 * loosely (`+1`, `1.0`), so anything an endpoint could decode as a number is checked as that number.
 */
export const conversationsNamed = (route: {
  readonly template: string;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly search: Readonly<Record<string, string | readonly string[]>>;
}): readonly number[] => {
  const named: number[] = [];
  if (BY_CONVERSATION.test(route.template)) {
    // An id the endpoint cannot decode is refused by its params schema; one it can, is checked here.
    named.push(asNumber(route.params.id) ?? Number.NaN);
  }
  const query = route.search.conversation;
  for (const value of typeof query === "string" ? [query] : (query ?? [])) {
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

/**
 * The User of a matched request, with the Conversations its route names checked against them: `Authentication`'s
 * whole check, and the shell route's.
 */
export const authorize = (token: string, template: string) =>
  Effect.gen(function* () {
    const user = yield* (yield* Auth).authenticate(token);
    const named = conversationsNamed({
      template,
      params: yield* HttpRouter.params,
      search: yield* HttpServerRequest.ParsedSearchParams,
    });
    for (const id of named) {
      yield* requireOwner(id, user.id);
    }
    return user;
  });

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth;
    const agents = yield* Agents;
    return Authentication.of({
      session: (httpEffect, { credential, endpoint }) =>
        Effect.gen(function* () {
          const user = yield* authorize(
            Redacted.value(credential),
            endpoint.path
          ).pipe(
            Effect.provideService(Auth, auth),
            Effect.provideService(Agents, agents)
          );
          return yield* Effect.provideService(httpEffect, CurrentUser, user);
        }),
    });
  })
);

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} satisfies Cookies.Cookie["options"];

/**
 * Set the session cookie, `Secure` when the request came through an https `publicUrl`. Plain http on loopback
 * leaves it off: not every browser stores a `Secure` cookie on http://localhost.
 */
const setSession = (
  token: string,
  maxAgeMs: number,
  publicUrl: URL | undefined
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* HttpApiBuilder.securitySetCookie(
      Authentication.security.session,
      token,
      {
        ...cookieOptions,
        secure: viaHttpsPublicUrl(request.headers, publicUrl),
        maxAge: `${Math.floor(maxAgeMs / 1000)} seconds`,
      }
    );
  });

const tokenOf = (request: HttpServerRequest.HttpServerRequest) =>
  request.cookies[SESSION_COOKIE];

/**
 * The `auth` group. Building it adopts, for the oldest account, whatever predates accounts (Conversations and
 * Trusted domains without an owner): setup does it for the first account, and doing it again at every start
 * finishes an adoption a crash interrupted. Both adoptions are idempotent.
 */
export const authHandlers = (options: {
  readonly publicUrl?: URL | undefined;
}) =>
  HttpApiBuilder.group(
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
            yield* setSession(token, SESSION_TTL_MS, options.publicUrl);
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
            yield* setSession(token, SESSION_TTL_MS, options.publicUrl);
            return user;
          })
        )
        .handle("logout", () =>
          Effect.gen(function* () {
            const token = tokenOf(yield* HttpServerRequest.HttpServerRequest);
            if (token !== undefined) {
              yield* auth.logout(token);
            }
            yield* setSession("", 0, options.publicUrl);
          })
        );
    })
  );
