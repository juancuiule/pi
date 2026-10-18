// Full-text search over Conversations: a resumable projection of the transcript log kept in a
// SQLite file of its own (SEARCH_DB), indexed when a Run ends and caught up at boot. Human-facing
// only — through /api/search and the console's palette; the agent gets no search tool.
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { Agents } from "../agents/agents.ts";
import type { AgentError } from "../agents/agents.ts";
import type { ConversationNotFound } from "../errors.ts";
import type { SearchResult } from "../server/api.ts";
import { indexedText, matchQuery, splitSnippet } from "./format.ts";
import { sqliteIndex } from "./store.ts";
import type { QueryRow } from "./store.ts";

export class SearchError extends Schema.TaggedError<SearchError>()(
  "SearchError",
  { cause: Schema.Defect() }
) {}

/** Store calls are synchronous; anything they throw is a SearchError. */
const indexed = <A>(run: () => A): Effect.Effect<A, SearchError> =>
  Effect.try({ try: run, catch: (cause) => new SearchError({ cause }) });

/** How many FTS rows a query reads before grouping; one conversation gets at most a few of them. */
const QUERY_ROWS = 200;
const QUERY_CONVERSATIONS = 20;
const QUERY_MATCHES = 3;
/** The zero-state list length — the palette's most-recent view. */
const RECENT = 12;
/** Entries are grouped into pages of this size for one putPage transaction each. */
const INDEX_PAGE = 200;

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
     * The startup catch-up over every stored conversation, archived ones included: running it
     * waits until that sweep has finished (a conversation's indexing failure is logged and does
     * not stop the others).
     */
    readonly catchUp: Effect.Effect<void>;
  }
>()("effect-pi/search/Search") {
  static readonly layer = (options: { readonly database: string }) =>
    Layer.effect(
      Search,
      Effect.gen(function* () {
        const agents = yield* Agents;
        const index = yield* Effect.acquireRelease(
          Effect.sync(() => sqliteIndex(options.database)),
          (opened) => Effect.sync(() => opened.close())
        );
        // One indexing run at a time: run-end and catch-up indexing can overlap.
        const writing = yield* Semaphore.make(1);

        const indexOne = Effect.fn("Search.indexConversation")(function* (
          id: ConversationId
        ) {
          const stored = yield* agents.get(id);
          yield* indexed(() =>
            index.putTitle(Number(id), stored.meta.title, stored.meta.createdAt)
          );
          const from = yield* indexed(() => index.cursorOf(Number(id)));
          const entries = yield* agents.entries(id, { from });
          yield* entries.pipe(
            Stream.grouped(INDEX_PAGE),
            Stream.runForEach((chunk) =>
              indexed(() => {
                const rows = chunk.flatMap((entry) => {
                  try {
                    const text = indexedText(entry);
                    return text === undefined
                      ? []
                      : [
                          {
                            ...text,
                            entryId: Number(entry.id),
                            conversationId: Number(entry.conversationId),
                          },
                        ];
                  } catch {
                    // One malformed entry is skipped, not fatal: the page's cursor still
                    // advances past it so indexing never wedges on a poisoned record.
                    return [];
                  }
                });
                const last = chunk.at(-1);
                if (last !== undefined) {
                  index.putPage(Number(id), Number(last.id), rows);
                }
              })
            )
          );
        });

        const indexConversation = (id: ConversationId) =>
          writing.withPermit(indexOne(id));

        const query = Effect.fn("Search.query")(function* (q: string) {
          const match = matchQuery(q);
          if (match === undefined) {
            const stored = yield* agents.list;
            return stored
              .toSorted((a, b) => b.meta.createdAt - a.meta.createdAt)
              .slice(0, RECENT)
              .map((each): SearchResult => ({
                id: Number(each.id),
                title: each.meta.title,
                archived: each.meta.archivedAt !== undefined,
                createdAt: each.meta.createdAt,
                matches: [],
              }));
          }
          const rows = yield* indexed(() => index.query(match, QUERY_ROWS));
          const groups = new Map<number, QueryRow[]>();
          for (const row of rows) {
            const group = groups.get(row.conversationId);
            if (group !== undefined) {
              if (group.length < QUERY_MATCHES) {
                group.push(row);
              }
            } else if (groups.size < QUERY_CONVERSATIONS) {
              groups.set(row.conversationId, [row]);
            }
          }
          const results: SearchResult[] = [];
          for (const [conversationId, matched] of groups) {
            // A hit can outlive its conversation if the index and the store disagree;
            // MetaDoc is authoritative, so the hit is dropped.
            const stored = yield* agents
              .get(conversationId as ConversationId)
              .pipe(
                Effect.catchTag("ConversationNotFound", () =>
                  Effect.succeed(null)
                )
              );
            if (stored === null) {
              continue;
            }
            results.push({
              id: conversationId,
              title: stored.meta.title,
              archived: stored.meta.archivedAt !== undefined,
              createdAt: stored.meta.createdAt,
              matches: matched.map((row) => ({
                ...(row.entryId === undefined ? {} : { entry: row.entryId }),
                role: row.role,
                snippet: splitSnippet(row.snippet),
                createdAt: row.createdAt,
              })),
            });
          }
          return results;
        });

        const swept = yield* Deferred.make<boolean, never>();
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const all = yield* agents.list;
            yield* Effect.forEach(
              all,
              (each) =>
                indexConversation(each.id).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `Indexing conversation ${each.id} failed`,
                      cause
                    )
                  )
                ),
              { discard: true }
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Search index catch-up failed", cause)
            ),
            // Done or failed, the sweep is over — awaiters continue either way.
            Effect.ensuring(Deferred.succeed(swept, true))
          )
        );

        // Awaiting the sweep's end lets callers (tests, the API) take it as a point-in-time
        // "everything stored is indexed" before they act.
        const catchUp = Deferred.await(swept).pipe(Effect.asVoid);

        return Search.of({ query, indexConversation, catchUp });
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
