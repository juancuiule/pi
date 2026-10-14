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
      case "CapacityExhausted": {
        const limit = "limit" in error ? String(error.limit) : "a few";
        const resource =
          "resource" in error && error.resource !== "seat"
            ? `${String(error.resource)} sandboxes`
            : "conversations";
        return `At most ${limit} ${resource} can run at once. Pause one first.`;
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
        return "This conversation no longer exists.";
      }
      case "ConversationArchived": {
        return "This conversation is archived. Unarchive it to continue.";
      }
      default: {
        return String(error._tag);
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
};

/** A failed API call: `message` for people, `failure` the server's typed error (or the client's). */
export class ApiFailureError extends Error {
  readonly failure: unknown;

  constructor(failure: unknown) {
    super(apiError(failure));
    this.name = "ApiFailureError";
    this.failure = failure;
  }
}

export interface CapacityShortage {
  readonly resource: "seat" | "shell" | "desktop";
  readonly limit: number;
  readonly holders: readonly number[];
}

/** The Capacity limit a failed call hit, if that is why it failed. */
export const capacityShortageOf = (
  error: unknown
): CapacityShortage | undefined => {
  const failure = error instanceof ApiFailureError ? error.failure : error;
  if (
    typeof failure !== "object" ||
    failure === null ||
    !("_tag" in failure) ||
    failure._tag !== "CapacityExhausted"
  ) {
    return undefined;
  }
  const { resource, limit, holders } = failure as unknown as CapacityShortage;
  return { resource, limit, holders };
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
  throw new ApiFailureError(Cause.squash(exit.cause));
};
