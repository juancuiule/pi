// Signed-in HTTP clients for tests that call the API: the first name signed in creates the first account (setup),
// later names are added and signed in like `pnpm user add` then the login form.
import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Auth, SESSION_COOKIE } from "../auth/auth.ts";

export const passwordOf = (name: string) => `password-of-${name}`;

/** The `cookie` header a signed-in test client sends, for clients that are not the HttpClient (a WebSocket). */
export class SessionCookie extends Context.Service<SessionCookie, string>()(
  "effect-pi/testing/SessionCookie"
) {}

/** `name`'s account and an HttpClient that sends its session cookie on every request. */
export const signIn = (name: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const client = yield* HttpClient.HttpClient;
    const { setup } = yield* auth.state();
    const signed = setup
      ? yield* auth.setup(name, passwordOf(name))
      : yield* auth
          .addUser(name, passwordOf(name))
          .pipe(Effect.andThen(auth.login(name, passwordOf(name))));
    const cookie = `${SESSION_COOKIE}=${signed.token}`;
    return {
      user: signed.user,
      cookie,
      client: client.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("cookie", cookie))
      ),
    };
  }).pipe(Effect.orDie);

/** Replaces the HttpClient with one signed in as `name` (the first account), and provides its SessionCookie. */
export const signedIn = (name = "alice") =>
  Layer.effectContext(
    Effect.map(signIn(name), ({ client, cookie }) =>
      Context.make(HttpClient.HttpClient, client).pipe(
        Context.add(SessionCookie, cookie)
      )
    )
  );
