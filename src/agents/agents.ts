// An Effect service over a pi-durable harness: how to run a Conversation. `create` records a new one, and `open`
// gives a Conversation a Seat (see GLOSSARY.md), with a Sandbox over its Workspace when its Level needs one. Which
// Conversations have Seats, and when that changes, is the server's concern (src/server/conversations.ts).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type {
  AgentEvent,
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Extension,
  Harness as HarnessType,
  Storage,
  WatchHandle,
} from "@earendil-works/pi-durable";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  LiveDoc,
  MemoryStorage,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { Cause, Scope } from "effect";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";

import type { ApprovalPolicy } from "../approvals.ts";
import { ApprovalDoc, clearApprovals, stopWaitingCalls } from "../approvals.ts";
import type { StoredConversation } from "../conversation-meta.ts";
import { MetaDoc } from "../conversation-meta.ts";
import type { SkillNotFound } from "../errors.ts";
import {
  ApprovalNotFound,
  ConversationArchived,
  ConversationNotFound,
} from "../errors.ts";
import type { McpServerConfig, McpServerState } from "../mcp.ts";
import { connectMcpServers } from "../mcp.ts";
import type { SandboxChoice, SandboxInfo } from "../sandbox/sandbox.ts";
import { SandboxDoc, SandboxError } from "../sandbox/sandbox.ts";
import type { SaveScreenshot } from "../screenshots.ts";
import { Skills, SkillsDoc, skillsExtension } from "../skills/skills.ts";
import { CodingTools } from "../tools/bash.ts";
import { Calculator } from "../tools/calculator.ts";
import { desktopExtension } from "../tools/desktop.ts";
import { makeAgentTracing } from "../tracing.ts";
import { WorkspaceDoc, Workspaces } from "../workspaces/workspaces.ts";

const context = BACKGROUND_CONTEXT;

const answerText = async (
  conversation: Pick<Conversation, "commit">,
  answer: EntryId
): Promise<string> => {
  const entry = await conversation.commit(
    (tx) => tx.entry(AssistantEntry, answer),
    context
  );
  const message = entry?.model?.[0] as AssistantMessage;
  return message.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("");
};

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  cause: Schema.Defect(),
}) {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new AgentError({ cause }) });

export interface Capabilities {
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    /** False for skills with `disable-model-invocation`: only `/skill:<name>` loads them. */
    readonly modelInvocable: boolean;
  }[];
  readonly mcp: readonly McpServerState[];
}

export interface AgentModel {
  readonly provider: string;
  readonly modelId: string;
}

/** The extensions a conversation runs with, by its Workspace's Level. */
export const extensionsFor = (
  level: SandboxChoice,
  desktop: Extension = desktopExtension()
): Extension[] => {
  switch (level) {
    case "none": {
      return [Calculator];
    }
    case "shell": {
      return [Calculator, CodingTools];
    }
    case "desktop": {
      return [Calculator, CodingTools, desktop];
    }
    default: {
      throw new TypeError(`Unknown Level: ${level satisfies never}`);
    }
  }
};

// Top-level conversation ids, in paged scans of one commit each; pages are sequential because each
// needs the previous cursor. Databases from before the subagent tool was removed can still hold its
// task-owned child conversations; they are skipped.
const scanTopLevel = async (
  harness: HarnessType,
  cursor: Cursor | undefined,
  ids: ConversationId[]
): Promise<ConversationId[]> => {
  const page = await harness.commit(
    (tx) => tx.scanConversations({}, 500, cursor),
    context
  );
  for (const record of page.items) {
    if (record.owner === undefined) {
      ids.push(record.id);
    }
  }
  return page.next === undefined ? ids : scanTopLevel(harness, page.next, ids);
};

/**
 * A document's committed values as a single-use stream, the current one first. Attached when the effect runs, so no
 * later commit is missed; finishing or interrupting the stream stops the watch.
 */
const watchStream = <V, A>(
  open: () => Promise<WatchHandle<V> | undefined>,
  map: (value: V) => A
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<A, Cause.Done>();
      const watch = yield* attempt(open);
      if (watch === undefined) {
        return yield* new AgentError({
          cause: new Error("The document cannot be watched."),
        });
      }
      Queue.offerUnsafe(queue, map(watch.value));
      watch.start((value) => {
        Queue.offerUnsafe(queue, map(value));
        return Promise.resolve();
      });
      void (async () => {
        await watch.closed;
        Queue.endUnsafe(queue);
      })();
      return Stream.fromQueue(queue).pipe(
        Stream.ensuring(Effect.promise(() => watch.stop()))
      );
    })
  );

/** A Conversation live in this process; it ends, and its Sandbox is removed, when the scope `open` ran in closes. */
export interface Seat {
  readonly id: ConversationId;
  /** This Seat's Sandbox; `undefined` at Level `none`. */
  readonly sandbox: SandboxInfo | undefined;
  /**
   * Send a prompt without waiting for the answer; it is queued as a follow-up while a Run is going. `/skill:` is
   * expanded against the conversation's skills first.
   */
  send(prompt: string): Effect.Effect<void, AgentError | SkillNotFound>;
  /** Send a prompt and wait for the answer's text; the model requests and tool calls are traced under it. */
  ask(prompt: string): Effect.Effect<string, AgentError>;
  /**
   * Abort the current Run and its queued inputs; a call waiting for approval reports that the user stopped it.
   * Completes once the conversation is idle.
   */
  readonly stop: Effect.Effect<void, AgentError>;
  /**
   * Decide a call waiting for approval. `always` also flips the policy to `auto` and approves every other waiting
   * call. Fails `ApprovalNotFound` when no call is waiting under `key`.
   */
  decide(
    key: string,
    decision: "approve" | "deny" | "always"
  ): Effect.Effect<void, AgentError | ApprovalNotFound>;
  /** Count of calls waiting for approval. */
  readonly pendingApprovals: Effect.Effect<number, AgentError>;
  /** Whether a Run is going, as last committed. */
  readonly running: Effect.Effect<boolean, AgentError>;
  /**
   * A count, one element after each commit that may change `running` (several commits may come as one), starting
   * now; read `running` for the state. Single-use, and must be run; finishing or interrupting it stops its watch.
   */
  readonly changes: Effect.Effect<
    Stream.Stream<number, AgentError>,
    AgentError
  >;
}

export class Agents extends Context.Service<
  Agents,
  {
    /** The model new conversations run on; /api/info reports it. */
    readonly model: AgentModel;
    /** The skills and MCP servers conversations can use, for the console. */
    readonly capabilities: Effect.Effect<Capabilities>;
    /**
     * Record a new Conversation, with the skills the source has now. Fails `SkillNotFound`, creating nothing, when
     * `prompt` (its first prompt, sent later through its Seat) forces an unknown skill.
     */
    create(options: {
      readonly prompt: string;
      readonly title: string;
      readonly level: SandboxChoice;
      readonly createdAt: number;
      readonly approvals?: ApprovalPolicy | undefined;
    }): Effect.Effect<ConversationId, AgentError | SkillNotFound>;
    /**
     * Give a Conversation a Seat until the scope closes: a Sandbox over its Workspace when its Level needs one, with
     * its skills copied in. Closing the scope aborts the conversation, then removes the Sandbox; the Workspace's
     * files stay. Capacity is the caller's to claim.
     */
    open(
      id: ConversationId
    ): Effect.Effect<
      Seat,
      AgentError | SandboxError | ConversationNotFound | ConversationArchived,
      Scope.Scope
    >;
    /** One stored Conversation. */
    get(
      id: ConversationId
    ): Effect.Effect<StoredConversation, AgentError | ConversationNotFound>;
    /** Every stored top-level Conversation, archived ones included; order irrelevant. */
    readonly list: Effect.Effect<readonly StoredConversation[], AgentError>;
    /** Archive a Conversation without a Seat: mark it, and delete its Workspace's files. */
    archive(
      id: ConversationId,
      at: number
    ): Effect.Effect<void, AgentError | SandboxError | ConversationNotFound>;
    /** Unarchive a Conversation; its Workspace starts empty. */
    unarchive(
      id: ConversationId
    ): Effect.Effect<void, AgentError | ConversationNotFound>;
    /**
     * Watch a conversation, with or without a Seat: a `snapshot` first, then the events of every later commit.
     * The watch starts when this effect completes, so the stream is single-use and must be run: finishing or
     * interrupting it stops the watch, and a stream that is never run keeps it until the harness closes.
     */
    events(
      id: ConversationId
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
  }
>()("effect-pi/Agents") {
  static readonly layer = (options: {
    readonly models: MutableModels;
    readonly model: AgentModel;
    /** Keep every desktop screenshot on the host as well; see `saveScreenshotsTo`. */
    readonly saveScreenshot?: SaveScreenshot;
    /** Persistent storage; MemoryStorage (the default) keeps tests ephemeral. */
    readonly storage?: Storage;
    /** Remote MCP servers; connected when the layer is built, closed when it is torn down. */
    readonly mcp?: readonly McpServerConfig[];
    /** How long to wait for each MCP server when the layer is built; 10 seconds by default. */
    readonly mcpConnectTimeoutMs?: number | undefined;
  }) =>
    Layer.effect(
      Agents,
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const registry = createRegistry();
        // Spans for model requests and tool calls use the tracer this layer is built with.
        const tracing = makeAgentTracing(yield* Effect.context<never>());
        registry.install(tracing.extension);
        // Skills are read from their source for every new conversation; the extension reads the conversation's.
        const skills = yield* Skills;
        const skillsExt = skillsExtension(skills);
        registry.install(skillsExt);
        const catalog = skills.catalog.pipe(
          Effect.mapError((cause) => new AgentError({ cause }))
        );
        const { problems } = yield* catalog;
        for (const problem of problems) {
          yield* Effect.logWarning(`skipped skill ${problem}`);
        }
        // Connected before the harness opens, so the tools are registered when conversations start. Never fails:
        // a server that cannot be reached is reported unavailable.
        const mcp = yield* Effect.acquireRelease(
          Effect.promise(() =>
            connectMcpServers(
              options.mcp ?? [],
              options.mcpConnectTimeoutMs === undefined
                ? {}
                : { connectTimeoutMs: options.mcpConnectTimeoutMs }
            )
          ),
          (connections) => Effect.promise(() => connections.close())
        );
        registry.install(mcp.extension);
        const desktop = desktopExtension(
          options.saveScreenshot === undefined
            ? {}
            : { saveScreenshot: options.saveScreenshot }
        );
        for (const extension of extensionsFor("desktop", desktop)) {
          registry.install(extension);
        }

        // The harness is opened when the layer is built and closed when it is torn down.
        const harness = yield* Effect.acquireRelease(
          attempt(() =>
            Harness.open(
              options.storage ?? new MemoryStorage(),
              {
                models: options.models,
                registry,
                // Every tool call runs in the Sandbox of its conversation's Seat; without one there is no
                // environment, and the file, shell and desktop tools fail with an error result.
                env: async ({ conversationId, read }, envContext) => {
                  const doc = await read.snapshot(
                    SandboxDoc,
                    conversationId,
                    envContext
                  );
                  return doc?.sandbox === undefined
                    ? undefined
                    : workspaces.env(doc.sandbox);
                },
              },
              context
            )
          ),
          (opened) => Effect.promise(() => opened.close(context))
        );

        // No Seat survives a restart, so a run interrupted by a crash would resume against a Sandbox that no
        // longer exists: every conversation with live work is aborted before the service answers. The first
        // `abort` enables scheduling for the whole harness, so another conversation's pending task may start before
        // its own abort mark lands — at worst one tool call failing for lack of a Sandbox, or one model request.
        // Each abort waits until its conversation is idle. Then every conversation is left without a Sandbox and
        // without waiting calls.
        yield* attempt(async () => {
          const inspection = await harness.inspect(context);
          const ids = new Set<ConversationId>();
          for (const task of inspection.tasks) {
            if (task.record.conversationId !== undefined) {
              ids.add(task.record.conversationId);
            }
          }
          for (const submission of inspection.submissions) {
            if (submission.conversationId !== undefined) {
              ids.add(submission.conversationId);
            }
          }
          await Promise.all(
            [...ids].map(async (id) => {
              const handle = await harness.conversation(id, context);
              await handle?.abort(context);
            })
          );
          const records = await scanTopLevel(harness, undefined, []);
          await Promise.all(
            records.map((id) =>
              harness.commit(async (tx) => {
                const approvals = await tx.doc(ApprovalDoc, id);
                approvals.pending = {};
                approvals.decisions = {};
                const sandbox = await tx.doc(SandboxDoc, id);
                delete sandbox.sandbox;
              }, context)
            )
          );
        });

        const handleOf = Effect.fnUntraced(function* (id: ConversationId) {
          const handle = yield* attempt(() =>
            harness.conversation(id, context)
          );
          if (handle === undefined) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          return handle;
        });

        // The skills a conversation recorded, or those a new one would get for one recorded without them.
        const skillsOf = (id: ConversationId) =>
          attempt(() => harness.snapshot(SkillsDoc, id, context)).pipe(
            Effect.flatMap((doc) =>
              doc?.skills === undefined
                ? catalog.pipe(Effect.map((current) => current.skills))
                : Effect.succeed(doc.skills)
            )
          );

        const expand = (prompt: string, id: ConversationId) =>
          prompt.includes("/skill:")
            ? skillsOf(id).pipe(
                Effect.flatMap((available) => skills.expand(prompt, available)),
                Effect.catchTag("SkillSourceError", (cause) =>
                  Effect.fail(new AgentError({ cause }))
                )
              )
            : Effect.succeed(prompt);

        const create = Effect.fn("Agents.create")(function* (createOptions: {
          readonly prompt: string;
          readonly title: string;
          readonly level: SandboxChoice;
          readonly createdAt: number;
          readonly approvals?: ApprovalPolicy | undefined;
        }) {
          // This conversation's skills: the source as it is now, kept for its whole life.
          const conversationSkills = (yield* catalog).skills;
          if (createOptions.prompt.includes("/skill:")) {
            yield* skills
              .expand(createOptions.prompt, conversationSkills)
              .pipe(
                Effect.catchTag("SkillSourceError", (cause) =>
                  Effect.fail(new AgentError({ cause }))
                )
              );
          }
          const created = yield* attempt(() =>
            harness.createConversation(
              {
                ownership: { kind: "ownerless" },
                agent: {
                  model: { ...options.model },
                  extensions: [
                    ...extensionsFor(createOptions.level, desktop),
                    ...(conversationSkills.length === 0 ? [] : [skillsExt]),
                    mcp.extension,
                    tracing.extension,
                  ],
                },
                init: async (tx, id) => {
                  const skillsDoc = await tx.doc(SkillsDoc, id);
                  skillsDoc.skills = [...conversationSkills];
                  const meta = await tx.doc(MetaDoc, id);
                  meta.meta = {
                    title: createOptions.title,
                    createdAt: createOptions.createdAt,
                  };
                  const workspace = await tx.doc(WorkspaceDoc, id);
                  workspace.level = createOptions.level;
                  const approvals = await tx.doc(ApprovalDoc, id);
                  approvals.policy = createOptions.approvals ?? "auto";
                },
              },
              context
            )
          );
          return created.id;
        });

        const open = Effect.fn("Agents.open")(function* (id: ConversationId) {
          const handle = yield* handleOf(id);
          const meta = yield* attempt(() =>
            harness.snapshot(MetaDoc, id, context)
          );
          if (meta?.meta?.archivedAt !== undefined) {
            return yield* new ConversationArchived({ id: Number(id) });
          }
          const workspace = yield* attempt(() =>
            harness.snapshot(WorkspaceDoc, id, context)
          );
          const level = workspace?.level ?? "none";
          let sandbox: SandboxInfo | undefined;
          if (level !== "none") {
            const machine = yield* workspaces.sandbox({
              level,
              storage: workspace?.storage,
            });
            ({ sandbox } = machine);
            const conversationSkills = yield* skillsOf(id);
            if (conversationSkills.length > 0) {
              yield* skills
                .install(workspaces.env(sandbox), conversationSkills, context)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new SandboxError({
                        message: `Could not copy skills into ${machine.sandbox.id}`,
                        cause,
                      })
                  )
                );
            }
            // Recorded before the Seat is returned, so no tool call of this Seat runs without its Sandbox. Cleared
            // when the Seat ends, before the Sandbox is removed.
            yield* Effect.acquireRelease(
              attempt(() =>
                harness.commit(async (tx) => {
                  const doc = await tx.doc(SandboxDoc, id);
                  doc.sandbox = machine.sandbox;
                  const files = await tx.doc(WorkspaceDoc, id);
                  files.storage = machine.storage;
                }, context)
              ),
              () =>
                Effect.ignore(
                  attempt(() =>
                    harness.commit(async (tx) => {
                      const doc = await tx.doc(SandboxDoc, id);
                      delete doc.sandbox;
                    }, context)
                  )
                )
            );
          }
          // Registered last, so it runs first: the conversation stops before its Sandbox goes.
          yield* Effect.addFinalizer(() =>
            Effect.ignore(attempt(() => handle.abort(context)))
          );

          const annotate = (prompt: string) =>
            Effect.annotateCurrentSpan({
              "langfuse.observation.type": "agent",
              "langfuse.observation.input": prompt,
              "langfuse.session.id": tracing.sessionOf(id),
            });

          const send = Effect.fn("Seat.send")(function* (prompt: string) {
            const expanded = yield* expand(prompt, id);
            yield* annotate(expanded);
            // Admitted without waiting: a busy conversation queues it as a follow-up, and the answer arrives as
            // events.
            yield* tracing.traced(
              id,
              attempt(() =>
                handle.submit(
                  { type: "input", content: expanded, whenBusy: "followUp" },
                  context
                )
              )
            );
          });

          const ask = Effect.fn("Seat.ask")(function* (prompt: string) {
            yield* annotate(prompt);
            const answer = yield* tracing.traced(
              id,
              attempt(async () => {
                const submission = await handle.submit(
                  { type: "input", content: prompt },
                  context
                );
                const settled = await submission.wait(context);
                if (settled.status !== "done" || settled.type !== "input") {
                  throw new Error(`Run failed: ${settled.status}`);
                }
                return answerText(handle, settled.answer);
              })
            );
            yield* Effect.annotateCurrentSpan(
              "langfuse.observation.output",
              answer
            );
            return answer;
          });

          const stop = attempt(async () => {
            await stopWaitingCalls(harness, id, context);
            await handle.abort(context);
            // The aborted calls' own cleanup commits may have been refused; none of them waits any more.
            await clearApprovals(harness, id, context);
          }).pipe(Effect.withSpan("Seat.stop"));

          const decide = Effect.fn("Seat.decide")(function* (
            key: string,
            decision: "approve" | "deny" | "always"
          ) {
            const found = yield* attempt(() =>
              harness.commit(async (tx) => {
                const doc = await tx.doc(ApprovalDoc, id);
                if (doc.pending[key] === undefined) {
                  return false;
                }
                if (decision === "always") {
                  // Parallel calls of the same round are already waiting; under `auto` none of them should.
                  doc.policy = "auto";
                  for (const waiting of Object.keys(doc.pending)) {
                    doc.decisions[waiting] ??= "approve";
                  }
                }
                doc.decisions[key] = decision === "deny" ? "deny" : "approve";
                return true;
              }, context)
            );
            if (!found) {
              return yield* new ApprovalNotFound({ key });
            }
          });

          const pendingApprovals = attempt(() =>
            harness.snapshot(ApprovalDoc, id, context)
          ).pipe(Effect.map((doc) => Object.keys(doc?.pending ?? {}).length));

          const running = attempt(() =>
            harness.snapshot(LiveDoc, id, context)
          ).pipe(Effect.map((live) => live?.run !== undefined));

          let delivered = 0;
          const changes = watchStream(
            () => harness.watchDoc(LiveDoc, id, context),
            () => {
              delivered += 1;
              return delivered;
            }
          );

          return {
            id,
            sandbox,
            send,
            ask,
            stop,
            decide,
            pendingApprovals,
            running,
            changes,
          } satisfies Seat;
        });

        // A conversation without metadata predates it, or is not a Conversation of this app.
        const stored = Effect.fnUntraced(function* (id: ConversationId) {
          const doc = yield* attempt(() =>
            harness.snapshot(MetaDoc, id, context)
          );
          if (doc?.meta === undefined) {
            return;
          }
          const workspace = yield* attempt(() =>
            harness.snapshot(WorkspaceDoc, id, context)
          );
          return {
            id,
            meta: doc.meta,
            level: workspace?.level ?? "none",
          } satisfies StoredConversation;
        });

        const get = Effect.fn("Agents.get")(function* (id: ConversationId) {
          const found = yield* stored(id);
          if (found === undefined) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          return found;
        });

        const list = Effect.gen(function* () {
          const ids = yield* attempt(() =>
            scanTopLevel(harness, undefined, [])
          );
          const conversations: StoredConversation[] = [];
          for (const id of ids) {
            const found = yield* stored(id);
            if (found !== undefined) {
              conversations.push(found);
            }
          }
          return conversations;
        }).pipe(Effect.withSpan("Agents.list"));

        const archive = Effect.fn("Agents.archive")(function* (
          id: ConversationId,
          at: number
        ) {
          yield* handleOf(id);
          const storage = yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, id);
              if (doc.meta !== undefined) {
                doc.meta = { ...doc.meta, archivedAt: at };
              }
              const approvals = await tx.doc(ApprovalDoc, id);
              approvals.pending = {};
              approvals.decisions = {};
              const workspace = await tx.doc(WorkspaceDoc, id);
              // Copied out: the draft cannot be read once the commit settles.
              const files =
                workspace.storage === undefined
                  ? undefined
                  : { ...workspace.storage };
              delete workspace.storage;
              return files;
            }, context)
          );
          if (storage !== undefined) {
            yield* workspaces.discard(storage);
          }
        });

        const unarchive = Effect.fn("Agents.unarchive")(function* (
          id: ConversationId
        ) {
          yield* handleOf(id);
          yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, id);
              if (doc.meta !== undefined) {
                const { archivedAt: _archivedAt, ...meta } = doc.meta;
                doc.meta = meta;
              }
            }, context)
          );
        });

        const events = Effect.fn("Agents.events")(function* (
          id: ConversationId
        ) {
          // Only an existence check; the watch below reads the conversation itself.
          yield* handleOf(id);
          // Attached now, not when the stream is run: events committed after this call are never missed. The attach
          // and wiring are uninterruptible, so an interrupt can never leave a watch without an owner; from then on
          // the stream's finalizer stops it.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
              const watch = yield* attempt(() =>
                watchEvents(harness, id, context)
              );
              Queue.offerUnsafe(queue, watch.snapshot);
              watch.start((batch) => {
                Queue.offerAllUnsafe(queue, batch);
                return Promise.resolve();
              });
              void (async () => {
                await watch.closed;
                Queue.endUnsafe(queue);
              })();
              return Stream.fromQueue(queue).pipe(
                Stream.ensuring(Effect.promise(() => watch.stop()))
              );
            })
          );
        });

        // The skills a new conversation would get. A source that cannot be read is a defect here (a 500).
        const capabilities = catalog.pipe(
          Effect.map((current): Capabilities => ({
            skills: current.skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              modelInvocable: !skill.disableModelInvocation,
            })),
            mcp: mcp.servers,
          })),
          Effect.orDie
        );

        return Agents.of({
          model: options.model,
          capabilities,
          create,
          open,
          get,
          list,
          archive,
          unarchive,
          events,
        });
      })
    );
}
