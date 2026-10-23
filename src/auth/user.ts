// oxlint-disable no-redeclare -- a schema and its type share a name, the Effect idiom
// A User and the rules for an account's name and password. Free of runtime dependencies beyond effect, so the API
// definition (and web/ through it) can import it.
import { Schema } from "effect";

/** The cookie carrying a session token. */
export const SESSION_COOKIE = "effect_pi_session";

/** A User's id: random, opaque, never shown. Conversations record it as their owner. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const User = Schema.Struct({
  id: UserId,
  name: Schema.String,
});
export type User = typeof User.Type;

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
export const NAME_RULE =
  "1 to 32 characters: lowercase letters, digits, dots, hyphens and underscores, starting with a letter or digit";
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;
export const PASSWORD_RULE = `${PASSWORD_MIN} to ${PASSWORD_MAX} characters`;

/** Why a name cannot be an account's, or `undefined` when it can. Names are compared lowercased. */
export const nameProblem = (name: string): string | undefined =>
  NAME_PATTERN.test(name) ? undefined : `The name must be ${NAME_RULE}.`;

export const passwordProblem = (password: string): string | undefined =>
  password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX
    ? undefined
    : `The password must be ${PASSWORD_RULE}.`;
