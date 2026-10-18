// Full-text search over Conversations: a resumable projection of the transcript log kept in a
// SQLite file of its own (SEARCH_DB), indexed when a Run ends and caught up at boot. Human-facing
// only — through /api/search and the console's palette; the agent gets no search tool.
import type { ConversationId } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Schema } from "effect";

import type { AgentError } from "../agents/agents.ts";
import type { ConversationNotFound } from "../errors.ts";
import type { SearchResult } from "../server/api.ts";

export class SearchError extends Schema.TaggedError<SearchError>()(
  "SearchError",
  { cause: Schema.Defect() }
) {}

export class Search extends Context.Service<
  Search,
  {
    /**
     * Ranked conversations matching `q`, snippets segmented, title and archived flag live from
     * MetaDoc. An empty or unmatchable `q` lists the most recent conversations with empty matches
     * (the palette's zero-state).
     */
    query(
      q: string
    ): Effect.Effect<readonly SearchResult[], SearchError | AgentError>;
    /**
     * Index a conversation's title and every transcript entry past its cursor. Idempotent —
     * re-running replaces rows and resumes from the cursor; serialized through one semaphore.
     */
    indexConversation(
      id: ConversationId
    ): Effect.Effect<void, SearchError | AgentError | ConversationNotFound>;
    /**
     * Startup catch-up over every stored conversation, archived ones included; a conversation's
     * indexing failure is logged and does not stop the others.
     */
    readonly catchUp: Effect.Effect<void>;
  }
>()("effect-pi/search/Search") {
  static readonly layer = (_options: { readonly database: string }) =>
    Layer.succeed(
      Search,
      Search.of({
        query: () => Effect.succeed([]),
        indexConversation: () => Effect.void,
        catchUp: Effect.void,
      })
    );

  static readonly temporary = Search.layer({ database: ":memory:" });

  static readonly none = Layer.succeed(
    Search,
    Search.of({
      query: () => Effect.succeed([]),
      indexConversation: () => Effect.void,
      catchUp: Effect.void,
    })
  );
}
