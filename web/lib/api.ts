import { Cause, Effect, Exit } from "effect";
// The typed client for the effect-pi server, derived from its HttpApi definition. Requests go to /api on this
// origin; next.config.ts rewrites them to the server.
import { Api } from "effect-pi/api";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const makeClient = Effect.suspend(() =>
  HttpApiClient.make(Api, { baseUrl: window.location.origin })
);

export type ApiClient = Effect.Success<typeof makeClient>;

/** A message for a failure from the API, for toasts and inline errors. */
export const apiError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "SandboxLimitReached": {
        const limit = "limit" in error ? String(error.limit) : "a few";
        return `At most ${limit} sandboxes can run at once. End one first.`;
      }
      case "SkillNotFound": {
        const name = "name" in error ? String(error.name) : "";
        const available =
          "available" in error && Array.isArray(error.available)
            ? error.available.join(", ")
            : "";
        return `No skill named ${name}. Available: ${available}.`;
      }
      case "ConversationNotFound": {
        return "This conversation has ended.";
      }
      default: {
        return String(error._tag);
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
};

export const runApi = async <A>(
  f: (client: ApiClient) => Effect.Effect<A, unknown>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    makeClient.pipe(Effect.flatMap(f), Effect.provide(FetchHttpClient.layer))
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw new Error(apiError(Cause.squash(exit.cause)));
};
