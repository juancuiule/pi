// Handlers for the API in api.ts. Agent and sandbox failures are defects: they surface as 500s.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type {
  ExecutionEnv,
  FileError,
  FileErrorCode,
  Result,
} from "@earendil-works/pi-durable/env";
import type { Schema } from "effect";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Agents } from "../agents/agents.ts";
import type { AgentError } from "../agents/agents.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import type { ArtifactView } from "../artifacts/artifacts.ts";
import { TrustedDomains } from "../artifacts/domains.ts";
import { Attachments, infoOf } from "../attachments/attachments.ts";
import type { User, UserId } from "../auth/user.ts";
import type { ConversationEvent } from "../conversation-events.ts";
import type { ConversationNotFound } from "../errors.ts";
import {
  ArtifactNotFound,
  CapacityExhausted,
  ConversationArchived,
  EmptyMessage,
  SandboxUnavailable,
  SkillNotFound,
  WorkspaceFileNotFound,
} from "../errors.ts";
import { Search } from "../search/search.ts";
import { Skills } from "../skills/skills.ts";
import { Api, CurrentUser } from "./api.ts";
import { AuthHandlers, AuthenticationLive, requireOwner } from "./auth.ts";
import { Conversations } from "./conversations.ts";
import { loopbackOnly } from "./loopback.ts";

// ConversationEvents are plain JSON (pi-durable's committed AgentEvents, and storage records); the cast only names that for the SSE schema.
const asJson = (event: ConversationEvent) => event as unknown as Schema.Json;

/** The wire shape of an admitted input: its submission's id, and its entry's once placed. */
const ackOf = (record: SubmissionRecord) => ({
  id: Number(record.id),
  status: record.status,
  ...(record.status === "placed" || record.status === "done"
    ? { entry: Number(record.entry) }
    : {}),
  ...(record.status === "unanswered"
    ? {
        reason: record.reason,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      }
    : {}),
});

/** A message needs text or attachments. */
const message = (payload: {
  readonly prompt?: string;
  readonly attachments?: readonly string[];
}): Effect.Effect<
  { readonly prompt: string; readonly attachments: readonly string[] },
  EmptyMessage
> => {
  const prompt = payload.prompt ?? "";
  const attachments = payload.attachments ?? [];
  return prompt.trim() === "" && attachments.length === 0
    ? Effect.fail(new EmptyMessage())
    : Effect.succeed({ prompt, attachments });
};

/** Run `f` with the request's signed-in User. */
const withUser = <A, E, R>(f: (user: User) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* f(yield* CurrentUser);
  });

/** Of `ids`, the ones `owner` owns, in order. */
const ownedOf = (ids: readonly number[], owner: UserId) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const owned: number[] = [];
    for (const id of ids) {
      if ((yield* agents.ownerOf(id as ConversationId)) === owner) {
        owned.push(id);
      }
    }
    return owned;
  }).pipe(Effect.catchTag("AgentError", Effect.die));

/**
 * Capacity is shared by every User, but a CapacityExhausted names only the caller's own holders: other people's
 * Conversations are not theirs to see or pause. Empty means the limit is held by others alone.
 */
const ownHolders = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is E & CapacityExhausted =>
      error instanceof CapacityExhausted,
    (full) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        return yield* new CapacityExhausted({
          resource: full.resource,
          limit: full.limit,
          holders: yield* ownedOf(full.holders, user.id),
        });
      })
  );

const ConversationsHandlers = HttpApiBuilder.group(
  Api,
  "conversations",
  Effect.fnUntraced(function* (handlers) {
    const conversations = yield* Conversations;
    return handlers
      .handle("list", () =>
        withUser((user) => conversations.list(user.id)).pipe(
          Effect.catchTag("AgentError", Effect.die)
        )
      )
      .handle("create", ({ payload }) =>
        message(payload).pipe(
          Effect.flatMap(({ prompt, attachments }) =>
            withUser((user) =>
              conversations.create({
                ...payload,
                prompt,
                attachments,
                owner: user.id,
              })
            )
          ),
          ownHolders,
          Effect.map(({ submission, ...summary }) => ({
            ...summary,
            submission: ackOf(submission),
          })),
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
            // A Conversation it just created is never missing or archived.
            ConversationNotFound: Effect.die,
            ConversationArchived: Effect.die,
          })
        )
      )
      .handle("send", ({ params, payload }) =>
        message(payload).pipe(
          Effect.flatMap(({ prompt, attachments }) =>
            conversations.send(
              params.id,
              prompt,
              attachments,
              payload.requestId
            )
          ),
          ownHolders,
          Effect.map(ackOf),
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("withdraw", ({ params }) =>
        conversations.withdraw(params.id, params.submission).pipe(
          Effect.map((outcome) => ({ outcome })),
          Effect.catchTag("AgentError", Effect.die)
        )
      )
      .handle("resume", ({ params }) =>
        conversations.resume(params.id).pipe(
          ownHolders,
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("pause", ({ params }) =>
        conversations
          .pause(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("stop", ({ params }) =>
        conversations
          .stop(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("upgrade", ({ params, payload }) =>
        conversations.upgrade(params.id, payload).pipe(
          ownHolders,
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("cancelWait", ({ params }) =>
        conversations.cancelWait(params.id).pipe(Effect.asVoid)
      )
      .handle("archive", ({ params }) =>
        conversations.archive(params.id).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("unarchive", ({ params }) =>
        conversations
          .unarchive(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("rename", ({ params, payload }) =>
        conversations
          .rename(params.id, payload.title)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("generateTitle", ({ params }) =>
        conversations
          .generateTitle(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("agent", ({ params }) =>
        conversations
          .agent(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("configure", ({ params, payload }) =>
        conversations.configure(params.id, payload).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("reset", ({ params }) =>
        conversations.reset(params.id).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("events", ({ params }) =>
        conversations.events(params.id).pipe(
          Effect.map((events) => events.pipe(Stream.map(asJson), Stream.orDie)),
          Effect.catchTag("AgentError", Effect.die)
        )
      )
      .handle("history", ({ params, query }) =>
        conversations
          .history(params.id, { before: query.before, limit: query.limit })
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("approvals", ({ params, payload }) =>
        conversations
          .decide(params.id, payload.key, payload.decision)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("answers", ({ params, payload }) =>
        conversations
          .answer(params.id, payload.key, payload.answers)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("feedback", ({ params, payload }) =>
        conversations
          .feedback(params.id, payload)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("report", ({ params, payload }) =>
        conversations
          .report(params.id, payload)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      );
  })
);

/** `Content-Disposition` for a download, with the name kept in UTF-8 and a plain fallback. */
const disposition = (name: string) => {
  const fallback = name.replaceAll(/[^\w.-]+/gu, "_") || "file";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const AttachmentsHandlers = HttpApiBuilder.group(
  Api,
  "attachments",
  Effect.fnUntraced(function* (handlers) {
    const attachments = yield* Attachments;
    const agents = yield* Agents;
    return handlers
      .handle("upload", ({ payload }) =>
        Effect.gen(function* () {
          if (payload.conversation !== undefined) {
            // A multipart field, which `Authentication` cannot see in the URL: checked here instead.
            yield* requireOwner(payload.conversation, (yield* CurrentUser).id);
            const stored = yield* agents.get(
              payload.conversation as ConversationId
            );
            if (stored.meta.archivedAt !== undefined) {
              return yield* new ConversationArchived({
                id: payload.conversation,
              });
            }
          }
          return yield* attachments.upload({
            path: payload.file.path,
            name: payload.file.name,
            contentType: payload.file.contentType,
            conversationId: payload.conversation,
          });
        }).pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("remove", ({ params }) => attachments.remove(params.id))
      .handle("original", ({ params, query }) =>
        attachments.file(params.id, query.conversation, "original").pipe(
          Effect.map(({ record, bytes }) =>
            // Always a download, never rendered: an HTML file must not run on this origin.
            HttpServerResponse.uint8Array(bytes, {
              contentType: record.mediaType,
              headers: {
                "content-disposition": disposition(record.name),
                "x-content-type-options": "nosniff",
                "content-security-policy": "sandbox",
                "cache-control": "private, no-store",
              },
            })
          )
        )
      )
      .handle("view", ({ params, query }) =>
        attachments.view(params.id, query.conversation).pipe(
          Effect.map(({ record, prepared }) => ({
            info: infoOf(record),
            prepared,
          }))
        )
      );
  })
);

const AttachmentImagesHandlers = HttpApiBuilder.group(
  Api,
  "attachmentImages",
  Effect.fnUntraced(function* (handlers) {
    const attachments = yield* Attachments;
    return handlers
      .handle("page", ({ params, query }) =>
        attachments.pageImage(params.id, query.conversation, params.page).pipe(
          Effect.map((bytes) =>
            HttpServerResponse.uint8Array(bytes, {
              contentType: "image/webp",
              headers: {
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=86400",
              },
            })
          )
        )
      )
      .handle("thumbnail", ({ params, query }) =>
        attachments.file(params.id, query.conversation, "thumbnail").pipe(
          Effect.map(({ bytes }) =>
            HttpServerResponse.uint8Array(bytes, {
              contentType: "image/webp",
              headers: {
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=86400",
              },
            })
          )
        )
      );
  })
);

/**
 * An artifact page's sandbox: scripts only inline or from this origin's artifact-libs, nothing fetched — but images
 * may also come from this origin (attachment thumbnails, PDF pages) and the person's Trusted domains.
 */
const artifactCsp = (domains: readonly string[]) =>
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src data: blob: 'self'${domains.map((domain) => ` ${domain}`).join("")}; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`;

/**
 * The JavaScript a page may load, by served name: each resolves to the file of that name in its package's dist
 * folder (the entry point's directory). Anything not in the map is a 404 — pages never reach a CDN.
 */
const ARTIFACT_LIBS: Record<string, string> = {
  "chart.umd.js": "chart.js",
  "pele.global.js": "pele",
};

/** An artifact's wire shape; the wire names its owner `conversation`, like the query param. */
const artifactInfoOf = (view: ArtifactView) => ({
  id: view.id,
  conversation: view.conversationId,
  title: view.title,
  createdAt: view.createdAt,
  updatedAt: view.updatedAt,
  versions: view.versions,
});

const require_ = createRequire(import.meta.url);

const libPath = (file: string) => {
  const pkg = ARTIFACT_LIBS[file];
  return pkg === undefined
    ? undefined
    : path.join(path.dirname(require_.resolve(pkg)), file);
};

const ArtifactsHandlers = HttpApiBuilder.group(
  Api,
  "artifacts",
  Effect.fnUntraced(function* (handlers) {
    const artifacts = yield* Artifacts;
    const domains = yield* TrustedDomains;
    const agents = yield* Agents;
    return handlers
      .handle("list", ({ query }) =>
        (query.conversation === undefined
          ? Effect.gen(function* () {
              const user = yield* CurrentUser;
              const stored = yield* agents.list.pipe(
                Effect.catchTag("AgentError", Effect.die)
              );
              return yield* artifacts.listIn(
                stored.flatMap((each) =>
                  each.meta.owner === user.id ? [Number(each.id)] : []
                )
              );
            })
          : artifacts.list(query.conversation)
        ).pipe(Effect.map((views) => views.map(artifactInfoOf)))
      )
      .handle("view", ({ params, query }) =>
        artifacts
          .view(query.conversation, params.id)
          .pipe(Effect.map(artifactInfoOf))
      )
      .handle("render", ({ params, query }) =>
        Effect.flatMap(
          artifacts.html(query.conversation, params.id, query.v),
          ({ html }) =>
            // `Authentication` checked the conversation is the caller's, so their list is its owner's.
            Effect.map(
              withUser((user) => domains.list(user.id)),
              (trusted) =>
                HttpServerResponse.text(html, {
                  contentType: "text/html",
                  headers: {
                    "content-security-policy": artifactCsp(trusted),
                    "x-content-type-options": "nosniff",
                    "cache-control": "no-store",
                  },
                })
            )
        )
      )
      .handle("source", ({ params, query }) =>
        artifacts.html(query.conversation, params.id, query.v)
      )
      .handle("remove", ({ params, query }) =>
        artifacts.remove(query.conversation, params.id)
      )
      .handle("lib", ({ params }) => {
        const file = libPath(params.file);
        return file === undefined
          ? Effect.fail(new ArtifactNotFound({ id: params.file }))
          : Effect.promise(() => readFile(file)).pipe(
              Effect.map((bytes) =>
                HttpServerResponse.uint8Array(bytes, {
                  contentType: "text/javascript",
                  headers: {
                    "x-content-type-options": "nosniff",
                    "cache-control": "no-store",
                  },
                })
              )
            );
      });
  })
);

/** The bytes one file view serves; a bigger file answers its first chunk with `truncated`. */
const FILE_TEXT_MAX = 256 * 1024;
/** The entries one directory listing serves at most. */
const FILE_LIST_MAX = 500;
/** The paths one tree listing serves at most; a bigger Workspace answers its first part with `truncated`. */
const FILE_TREE_MAX = 4000;
/** Directory names the tree lists as markers but never descends: bulk no one browses. */
const TREE_SKIP_DESCEND: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
]);

/** The Workspace-relative path of an entry inside `dir`; the root's own entries are bare names. */
const relPath = (dir: string, name: string): string =>
  dir === "" ? name : `${dir}/${name}`;

/** Directories first, then names — the Files tab's order. */
const byKindThenName = (
  a: { readonly name: string; readonly kind: string },
  b: { readonly name: string; readonly kind: string }
) =>
  Number(b.kind === "directory") - Number(a.kind === "directory") ||
  a.name.localeCompare(b.name);

/** FileError codes that mean "nothing readable at this path"; any other failure is a defect. */
const FILE_GONE: ReadonlySet<FileErrorCode> = new Set([
  "not_found",
  "not_directory",
  "is_directory",
  "permission_denied",
  "invalid",
]);

/**
 * One FileSystem call: the promise rejecting is a defect (the env broke), an `ok` result the value, and any
 * `FILE_GONE` error `WorkspaceFileNotFound` — to the console they are all "nothing at this path".
 */
const fileCall = <A>(
  requested: string,
  result: Promise<Result<A, FileError>>
) =>
  Effect.promise(() => result).pipe(
    Effect.flatMap((r) => {
      if (r.ok) {
        return Effect.succeed(r.value);
      }
      if (FILE_GONE.has(r.error.code)) {
        return Effect.fail(new WorkspaceFileNotFound({ path: requested }));
      }
      return Effect.die(r.error);
    })
  );

const context = BACKGROUND_CONTEXT;

/** `asked` resolved inside the env's workspace root; `..` or a symlink escaping it reads as not found. */
const confined = (
  env: ExecutionEnv,
  root: string,
  asked: string
): Effect.Effect<string, WorkspaceFileNotFound> =>
  fileCall(asked, env.canonicalPath(asked, context)).pipe(
    Effect.flatMap((resolved) =>
      resolved === root || resolved.startsWith(`${root}/`)
        ? Effect.succeed(resolved)
        : Effect.fail(new WorkspaceFileNotFound({ path: asked }))
    )
  );

const rootOf = (
  env: ExecutionEnv
): Effect.Effect<string, WorkspaceFileNotFound> =>
  fileCall("/", env.canonicalPath(env.cwd, context));

const FilesHandlers = HttpApiBuilder.group(
  Api,
  "files",
  Effect.fnUntraced(function* (handlers) {
    const conversations = yield* Conversations;
    const agents = yield* Agents;

    /**
     * The Seat's Sandbox env, which Workspace files are read through. A paused Conversation has none
     * (`SandboxUnavailable`; its files wait for the next Seat) and neither does a Level `none` one;
     * an unknown id is `ConversationNotFound`.
     */
    const envOf = (
      id: number
    ): Effect.Effect<
      ExecutionEnv,
      AgentError | ConversationNotFound | SandboxUnavailable
    > =>
      Effect.gen(function* () {
        const seat = yield* conversations.seat(id);
        if (seat === undefined) {
          yield* agents.get(id as ConversationId);
          return yield* new SandboxUnavailable({ id });
        }
        return yield* seat.env;
      });

    return handlers
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          const env = yield* envOf(params.id);
          const root = yield* rootOf(env);
          const asked = query.path ?? "";
          const resolved = yield* confined(env, root, asked || ".");
          const info = yield* fileCall(asked, env.fileInfo(resolved, context));
          if (info.kind !== "directory") {
            return yield* new WorkspaceFileNotFound({ path: asked });
          }
          const entries = yield* fileCall(
            asked,
            env.listDir(resolved, context)
          );
          const prefix =
            resolved === root ? "" : `${resolved.slice(root.length + 1)}/`;
          const sorted = entries.toSorted(byKindThenName);
          return {
            entries: sorted.slice(0, FILE_LIST_MAX).map((entry) => ({
              name: entry.name,
              path: `${prefix}${entry.name}`,
              kind: entry.kind,
              size: entry.size,
              mtimeMs: entry.mtimeMs,
            })),
            truncated: entries.length > FILE_LIST_MAX,
          };
        }).pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("content", ({ params, query }) =>
        Effect.gen(function* () {
          const env = yield* envOf(params.id);
          const root = yield* rootOf(env);
          const resolved = yield* confined(env, root, query.path);
          // A directory fails here, before any read.
          const reader = yield* fileCall(
            query.path,
            env.openBinaryReader(resolved, {}, context)
          );
          const info = yield* fileCall(query.path, reader.info(context));
          const bytes = yield* fileCall(
            query.path,
            reader.read(0, Math.min(info.size, FILE_TEXT_MAX), context)
          ).pipe(Effect.ensuring(Effect.promise(() => reader.close(context))));
          const truncated = info.size > bytes.length;
          // `stream` keeps a trailing multibyte sequence cut by the cap from failing the decode.
          const text = bytes.includes(0)
            ? undefined
            : ((() => {
                try {
                  return new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes,
                    { stream: truncated }
                  );
                } catch {
                  return null;
                }
              })() ?? undefined);
          const shown = resolved.slice(root.length + 1);
          return text === undefined
            ? { path: shown, size: info.size, truncated, binary: true }
            : {
                path: shown,
                size: info.size,
                truncated,
                binary: false,
                text,
              };
        }).pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("tree", ({ params }) =>
        Effect.gen(function* () {
          const env = yield* envOf(params.id);
          const root = yield* rootOf(env);
          // Breadth-first: a listing that hits the cap is cut inside the deepest entries, not the
          // first-sorted subtree, so shallow paths always appear. Each page is one directory's
          // entries and the state is the queue left to descend; symlinked directories are never
          // descended (`listDir` reports them `symlink`, never `directory`): a link could cycle or
          // point outside.
          const listing = Stream.paginate(
            [""] as readonly string[],
            (queue) => {
              const [dir, ...rest] = queue;
              return fileCall(
                dir === "" ? "/" : dir,
                env.listDir(dir === "" ? root : `${root}/${dir}`, context)
              ).pipe(
                Effect.map((entries) => {
                  const sorted = entries.toSorted(byKindThenName);
                  const next = [
                    ...rest,
                    ...sorted.flatMap((entry) =>
                      entry.kind === "directory" &&
                      !TREE_SKIP_DESCEND.has(entry.name)
                        ? [relPath(dir, entry.name)]
                        : []
                    ),
                  ];
                  return [
                    sorted.map((entry) =>
                      entry.kind === "directory"
                        ? `${relPath(dir, entry.name)}/`
                        : relPath(dir, entry.name)
                    ),
                    next.length === 0
                      ? Option.none<readonly string[]>()
                      : Option.some(next),
                  ] as const;
                })
              );
            }
          );
          const collected = yield* Stream.runCollect(
            listing.pipe(Stream.take(FILE_TREE_MAX + 1))
          );
          return {
            paths: collected.slice(0, FILE_TREE_MAX),
            truncated: collected.length > FILE_TREE_MAX,
          };
        }).pipe(Effect.catchTag("AgentError", Effect.die))
      );
  })
);

const SkillsHandlers = HttpApiBuilder.group(
  Api,
  "skills",
  Effect.fnUntraced(function* (handlers) {
    const skills = yield* Skills;
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    return handlers
      .handle("save", ({ params, payload }) =>
        Effect.map(skills.save(params.name, payload.files), ({ skill }) => ({
          name: skill.name,
          description: skill.description,
          files: [...skill.files],
        })).pipe(Effect.catchTag("SkillSourceError", Effect.die))
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const folder = yield* skills.folder(params.name);
          if (folder === undefined) {
            const catalog = yield* skills.catalog;
            return yield* new SkillNotFound({
              name: params.name,
              available: catalog.skills.map((skill) => skill.name),
            });
          }
          const files: Record<string, string> = {};
          const binaryFiles: string[] = [];
          for (const [file, bytes] of Object.entries(folder.files)) {
            try {
              files[file] = utf8.decode(bytes);
            } catch {
              binaryFiles.push(file);
            }
          }
          return {
            name: params.name,
            origin: folder.origin,
            files,
            binaryFiles: binaryFiles.toSorted(),
          };
        }).pipe(Effect.catchTag("SkillSourceError", Effect.die))
      )
      .handle("remove", ({ params }) =>
        skills
          .remove(params.name)
          .pipe(Effect.asVoid, Effect.catchTag("SkillSourceError", Effect.die))
      );
  })
);

const TrustedDomainsHandlers = HttpApiBuilder.group(
  Api,
  "trustedDomains",
  Effect.fnUntraced(function* (handlers) {
    const domains = yield* TrustedDomains;
    return handlers
      .handle("list", () => withUser((user) => domains.list(user.id)))
      .handle("add", ({ payload }) =>
        withUser((user) =>
          Effect.map(domains.add(user.id, payload.domain), (domain) => ({
            domain,
          }))
        )
      )
      .handle("remove", ({ params }) =>
        withUser((user) =>
          Effect.asVoid(domains.remove(user.id, params.domain))
        )
      );
  })
);

const infoHandlers = (options: {
  readonly apiUrl: string;
  readonly tracing: boolean;
}) =>
  HttpApiBuilder.group(
    Api,
    "info",
    Effect.fnUntraced(function* (handlers) {
      const {
        capabilities,
        model: { provider, modelId },
        titleGeneration,
      } = yield* Agents;
      const { capacity } = yield* Conversations;
      const model = `${provider}/${modelId}`;
      return (
        handlers
          .handle("get", () =>
            Effect.succeed({
              model,
              apiUrl: options.apiUrl,
              tracing: options.tracing,
              titleGeneration,
            })
          )
          .handle("capabilities", () => capabilities)
          // Limits are shared; holders and waiters are the caller's own only, like a CapacityExhausted's.
          .handle("capacity", () =>
            Effect.gen(function* () {
              const user = yield* CurrentUser;
              const own = [];
              for (const each of yield* capacity) {
                own.push({
                  ...each,
                  inUse: each.holders.length,
                  holders: yield* ownedOf(each.holders, user.id),
                  waiting: yield* ownedOf(each.waiting, user.id),
                });
              }
              return own;
            })
          )
      );
    })
  );

const SearchHandlers = HttpApiBuilder.group(Api, "search", (handlers) =>
  Effect.gen(function* () {
    const search = yield* Search;
    return handlers.handle("query", ({ query }) =>
      withUser((user) => search.query(query.q, user.id)).pipe(
        Effect.catchTags({
          AgentError: Effect.die,
          SearchError: Effect.die,
        })
      )
    );
  })
);

/**
 * The HTTP API; `apiUrl` is the server's own address, reported by `/api/info`, `tracing` whether the
 * server traces to Langfuse.
 */
export const apiLayer = (options: {
  readonly apiUrl: string;
  readonly tracing: boolean;
  /** The ports a browser page may call from: the console's and this server's. Unset, any loopback port. */
  readonly pagePorts?: readonly number[] | undefined;
}) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(
      Layer.mergeAll(
        ConversationsHandlers,
        AttachmentsHandlers,
        AttachmentImagesHandlers,
        ArtifactsHandlers,
        TrustedDomainsHandlers,
        SkillsHandlers,
        FilesHandlers,
        SearchHandlers,
        infoHandlers(options),
        AuthHandlers
      )
    ),
    Layer.provide(AuthenticationLive),
    Layer.merge(loopbackOnly({ pagePorts: options.pagePorts }))
  );
