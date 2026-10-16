// Pages the agent writes for the person to look at beside the chat (see docs/plans/artifacts.md): reports,
// charts, dashboards and prototypes as sandboxed HTML. `Artifacts` keeps one artifact per page with every version
// in the EFFECT_PI_DB file, scoped to its conversation like a sent attachment. The `artifacts` extension gives the
// agent `artifact_create` and `artifact_update`, on the host, so they work at every Level.
import { randomBytes } from "node:crypto";

import { Type } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Clock, Context, Effect, Layer } from "effect";

import { ArtifactNotFound, ArtifactRefused } from "../errors.ts";
import { sqliteRecords } from "./store.ts";
import type {
  ArtifactRecord,
  ArtifactRecords,
  ArtifactVersionInfo,
} from "./store.ts";

export const ARTIFACT_ID = /^art_[0-9a-f]{32}$/u;

/** A version's page can be at most this many bytes. */
export const ARTIFACT_MAX_BYTES = 300 * 1024;
/** Edits one `artifact_update` call can carry. */
export const ARTIFACT_MAX_EDITS = 20;

/** What a tool result's details carry so the console can open the page. */
export interface ArtifactRef {
  readonly id: string;
  readonly version: number;
  readonly title: string;
}

/** One exact find/replace pair over the current page; `find` must occur exactly once. */
export interface ArtifactEdit {
  readonly find: string;
  readonly replace: string;
}

/** A new version of an artifact: a whole page, or edits over the current one, with an optional new title. */
export type ArtifactUpdate = {
  readonly callId: string;
  readonly title?: string | undefined;
} & ({ readonly html: string } | { readonly edits: readonly ArtifactEdit[] });

/** An artifact as the API and the console see it. */
export interface ArtifactView {
  readonly id: string;
  /** The conversation that owns it; every artifact belongs to exactly one. */
  readonly conversationId: number;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly versions: readonly ArtifactVersionInfo[];
}

const byteLength = (html: string) => Buffer.byteLength(html, "utf-8");

const refused = (reason: string) => new ArtifactRefused({ reason });

const checkSize = (html: string) =>
  byteLength(html) > ARTIFACT_MAX_BYTES
    ? Effect.fail(
        refused(
          `A page can be at most ${Math.round(ARTIFACT_MAX_BYTES / 1024)} KB; this one is ${Math.ceil(byteLength(html) / 1024)} KB.`
        )
      )
    : Effect.void;

/** How often `find` occurs in `html`; an empty `find` is refused before this is read. */
const occurrences = (html: string, find: string) =>
  find === "" ? 0 : html.split(find).length - 1;

/** Quoted `find`, cut short, for a refusal the model reads. */
const quoted = (find: string) =>
  find.length > 60 ? `"${find.slice(0, 57)}..."` : `"${find}"`;

/** Fail with the first reason `edits` cannot apply to `html`; each `find` must occur exactly once. */
const checkEdits = (html: string, edits: readonly ArtifactEdit[]) => {
  if (edits.length > ARTIFACT_MAX_EDITS) {
    return Effect.fail(
      refused(
        `A call can carry at most ${ARTIFACT_MAX_EDITS} edits; this one has ${edits.length}.`
      )
    );
  }
  for (const edit of edits) {
    const found = occurrences(html, edit.find);
    if (edit.find === "" || found === 0) {
      return Effect.fail(
        refused(`The text to find is not in the page: ${quoted(edit.find)}`)
      );
    }
    if (found > 1) {
      return Effect.fail(
        refused(
          `The text to find occurs ${found} times in the page; make it longer so it occurs once: ${quoted(edit.find)}`
        )
      );
    }
  }
  return Effect.void;
};

export class Artifacts extends Context.Service<
  Artifacts,
  {
    /**
     * Create an artifact with its first version; `callId` is the tool call's, so a replayed call returns the
     * version it already wrote instead of adding another.
     */
    create(
      conversationId: number,
      input: {
        readonly title: string;
        readonly html: string;
        readonly callId: string;
      }
    ): Effect.Effect<ArtifactRef, ArtifactRefused>;
    /**
     * A new version of the conversation's artifact: a whole page (`html`) or exact edits over the current one
     * (`edits`), all or none, plus an optional new `title`. A replayed `callId` returns its version.
     */
    update(
      conversationId: number,
      id: string,
      update: ArtifactUpdate
    ): Effect.Effect<ArtifactRef, ArtifactNotFound | ArtifactRefused>;
    /** The conversation's artifact: its title and every version. `undefined` scopes to no conversation. */
    view(
      conversationId: number | undefined,
      id: string
    ): Effect.Effect<ArtifactView, ArtifactNotFound>;
    /** One version's page, the latest by default. `undefined` scopes to no conversation. */
    html(
      conversationId: number | undefined,
      id: string,
      version?: number
    ): Effect.Effect<
      { readonly version: number; readonly html: string },
      ArtifactNotFound
    >;
    /** The conversation's artifacts, oldest first. */
    list(conversationId: number): Effect.Effect<readonly ArtifactView[]>;
    /**
     * Every artifact across conversations, most recently updated first. A separate method, not `list` with an
     * optional scope: on this service `undefined` scope always means finds nothing, never everything.
     */
    listAll(): Effect.Effect<readonly ArtifactView[]>;
    /** Delete the conversation's artifact and all its versions. `undefined` scopes to no conversation. */
    remove(
      conversationId: number | undefined,
      id: string
    ): Effect.Effect<void, ArtifactNotFound>;
  }
>()("effect-pi/Artifacts") {
  static readonly layer = (options: { readonly records: ArtifactRecords }) =>
    Layer.effect(
      Artifacts,
      Effect.sync(() => {
        const { records } = options;

        const viewOf = (artifact: ArtifactRecord): ArtifactView => ({
          id: artifact.id,
          conversationId: artifact.conversationId,
          title: artifact.title,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          versions: records.versions(artifact.id),
        });

        const create = Effect.fn("Artifacts.create")(function* (
          conversationId: number,
          input: { title: string; html: string; callId: string }
        ) {
          yield* checkSize(input.html);
          const replayed = records.versionByCallId(
            input.callId,
            conversationId
          );
          if (replayed !== undefined) {
            return {
              id: replayed.artifactId,
              version: replayed.version,
              title: replayed.title,
            };
          }
          const id = `art_${randomBytes(16).toString("hex")}`;
          const now = yield* Clock.currentTimeMillis;
          records.insert(
            {
              id,
              conversationId,
              title: input.title,
              createdAt: now,
              updatedAt: now,
            },
            {
              artifactId: id,
              version: 1,
              title: input.title,
              html: input.html,
              callId: input.callId,
              createdAt: now,
            }
          );
          return { id, version: 1, title: input.title };
        });

        const update = Effect.fn("Artifacts.update")(function* (
          conversationId: number,
          id: string,
          change: ArtifactUpdate
        ) {
          const replayed = records.versionByCallId(
            change.callId,
            conversationId
          );
          if (replayed !== undefined) {
            return {
              id: replayed.artifactId,
              version: replayed.version,
              title: replayed.title,
            };
          }
          const artifact = records.get(id, conversationId);
          if (artifact === undefined) {
            return yield* new ArtifactNotFound({ id });
          }
          const current = records.latest(id);
          let html: string;
          if ("edits" in change) {
            yield* checkEdits(current?.html ?? "", change.edits);
            html = current?.html ?? "";
            for (const edit of change.edits) {
              // A function replacement: "$" sequences in `replace` stay literal.
              html = html.replace(edit.find, () => edit.replace);
            }
          } else {
            ({ html } = change);
          }
          yield* checkSize(html);
          const now = yield* Clock.currentTimeMillis;
          const title = change.title ?? artifact.title;
          const record = {
            artifactId: id,
            version: (current?.version ?? 0) + 1,
            title,
            html,
            callId: change.callId,
            createdAt: now,
          };
          records.addVersion(id, title, now, record);
          return { id, version: record.version, title };
        });

        return Artifacts.of({
          create,
          update,
          view: (conversationId, id) =>
            Effect.suspend(() => {
              const artifact =
                conversationId === undefined
                  ? undefined
                  : records.get(id, conversationId);
              return artifact === undefined
                ? Effect.fail(new ArtifactNotFound({ id }))
                : Effect.succeed(viewOf(artifact));
            }),
          html: (conversationId, id, version) =>
            Effect.suspend(() => {
              if (
                conversationId === undefined ||
                records.get(id, conversationId) === undefined
              ) {
                return Effect.fail(new ArtifactNotFound({ id }));
              }
              const found =
                version === undefined
                  ? records.latest(id)
                  : records.version(id, version);
              return found === undefined
                ? Effect.fail(new ArtifactNotFound({ id }))
                : Effect.succeed({
                    version: found.version,
                    html: found.html,
                  });
            }),
          list: (conversationId) =>
            Effect.sync(() => records.list(conversationId).map(viewOf)),
          listAll: () => Effect.sync(() => records.listAll().map(viewOf)),
          remove: (conversationId, id) =>
            Effect.suspend(() =>
              conversationId !== undefined && records.remove(id, conversationId)
                ? Effect.void
                : Effect.fail(new ArtifactNotFound({ id }))
            ),
        });
      })
    );

  /** Artifacts in a SQLite file. */
  static readonly local = (options: { readonly database: string }) =>
    Layer.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => sqliteRecords(options.database)),
        (records) => Effect.sync(() => records.close())
      ).pipe(Effect.map((records) => Artifacts.layer({ records })))
    );

  /** Artifacts in an in-memory table, gone with the layer: for tests. */
  static readonly temporary = () => Artifacts.local({ database: ":memory:" });
}

const KB = 1024;

const SECTION = [
  `An artifact is a page the person sees beside this chat: use artifact_create for reports, charts, dashboards or interactive prototypes that are easier to read or use than text in a message. artifact_update changes one, either replacing the whole page or applying exact find/replace edits; every change is a new version the person can go back to.`,
  "A page is one self-contained HTML document, at most 300 KB: inline styles and scripts only. It must not fetch anything — no external scripts, stylesheets, fonts or images, and no network calls. Two libraries are served locally:",
  '<script src="/api/artifact-libs/chart.umd.js"></script> gives the Chart global.',
  '<script src="/api/artifact-libs/mermaid.min.js"></script> gives mermaid: call mermaid.initialize({ startOnLoad: false }), then render with mermaid.run or mermaid.render.',
  "The person sees the page the moment the call returns, so describe what it shows instead of pasting its HTML.",
].join("\n");

const textResult = (text: string) => ({
  content: [{ type: "text", text } satisfies TextContent],
});

/** Run an artifact call for a tool: a missing artifact or a refused change is an error the model reads. */
const run = <A>(effect: Effect.Effect<A, ArtifactNotFound | ArtifactRefused>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchTags({
        ArtifactNotFound: ({ id }) =>
          Effect.die(new Error(`No artifact ${id} in this conversation.`)),
        ArtifactRefused: ({ reason }) => Effect.die(new Error(reason)),
      })
    )
  );

/**
 * The `artifacts` extension: a prompt section, and the create and update tools over the conversation's
 * artifacts. They run on the host, so a conversation without a Sandbox still produces pages.
 */
export const artifactsExtension = (
  artifacts: Artifacts["Service"]
): Extension => {
  const title = Type.String({
    description: "A short title the person sees, a few words",
  });
  const page = `The page: one self-contained HTML document, at most ${Math.round(ARTIFACT_MAX_BYTES / KB)} KB`;
  return defineExtension({
    name: "artifacts",
    sections: [section("artifacts", () => SECTION)],
    tools: [
      defineTool({
        name: "artifact_create",
        description: `Create a page the person sees beside the chat (an artifact): ${page.toLowerCase()}. The result gives its id for artifact_update.`,
        parameters: Type.Object({
          title,
          html: Type.String({ description: page }),
        }),
        execute: async (args, api) => {
          const ref = await run(
            artifacts.create(Number(api.conversationId), {
              title: args.title,
              html: args.html,
              callId: api.callId,
            })
          );
          return {
            content: [
              {
                type: "text",
                text: `Created "${ref.title}" (${ref.id}), version ${ref.version}: the person already sees the page. Describe what it shows or does; do not paste the HTML.`,
              } satisfies TextContent,
            ],
            details: { ...ref },
          };
        },
      }),
      defineTool({
        name: "artifact_update",
        description: `Change an artifact into a new version: pass "html" for a whole new page, or "edits" of exact find/replace pairs over the current one (each "find" must occur exactly once; at most ${ARTIFACT_MAX_EDITS}), and optionally a new "title".`,
        parameters: Type.Object({
          id: Type.String({ description: "The artifact's id, e.g. art_…" }),
          html: Type.Optional(
            Type.String({ description: `${page}; replaces the current one` })
          ),
          edits: Type.Optional(
            Type.Array(
              Type.Object({
                find: Type.String({
                  description: "Text occurring exactly once in the page",
                }),
                replace: Type.String({
                  description: "What goes in its place",
                }),
              }),
              {
                maxItems: ARTIFACT_MAX_EDITS,
                description: "Exact find/replace pairs over the current page",
              }
            )
          ),
          title: Type.Optional(title),
        }),
        execute: async (args, api) => {
          let update: ArtifactUpdate;
          if (args.html !== undefined && args.edits === undefined) {
            update = { callId: api.callId, html: args.html };
          } else if (args.edits !== undefined && args.html === undefined) {
            update = { callId: api.callId, edits: args.edits };
          } else {
            return {
              ...textResult(
                'Pass exactly one of "html" or "edits": a whole new page, or exact find/replace pairs over the current one.'
              ),
              isError: true,
            };
          }
          const ref = await run(
            artifacts.update(Number(api.conversationId), args.id, {
              ...update,
              ...(args.title === undefined ? {} : { title: args.title }),
            })
          );
          return {
            content: [
              {
                type: "text",
                text: `Updated "${ref.title}" (${ref.id}) to version ${ref.version}: the person already sees the page. Describe what changed; do not paste the HTML.`,
              } satisfies TextContent,
            ],
            details: { ...ref },
          };
        },
      }),
    ],
  });
};
