// An Effect service over a pi-durable harness. Each conversation is started with the sandbox the user picks
// (none, shell or desktop).
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
  Storage,
} from "@earendil-works/pi-durable";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { Cause, Scope } from "effect";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";

import type { ApprovalPolicy } from "../approvals.ts";
import { ApprovalDoc } from "../approvals.ts";
import type { StoredConversation } from "../conversation-meta.ts";
import { MetaDoc } from "../conversation-meta.ts";
import type { SkillNotFound } from "../errors.ts";
import { ApprovalNotFound, ConversationNotFound } from "../errors.ts";
import type { McpServerConfig, McpServerState } from "../mcp.ts";
import { connectMcpServers } from "../mcp.ts";
import type { SandboxChoice, SandboxInfo } from "../sandbox/sandbox.ts";
import { SandboxDoc, SandboxError } from "../sandbox/sandbox.ts";
import type { SaveScreenshot } from "../screenshots.ts";
import { Skills, SkillsDoc, skillsExtension } from "../skills/skills.ts";
import { CodingTools } from "../tools/bash.ts";
import { Calculator } from "../tools/calculator.ts";
import { desktopExtension } from "../tools/desktop.ts";
import type { AgentTracing } from "../tracing.ts";
import { makeAgentTracing } from "../tracing.ts";
import type { StorageRef } from "../workspaces/workspaces.ts";
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

// ─── Effect: the agent harness as a service ─────────────────────────────────

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  cause: Schema.Defect(),
}) {}

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

/** The extensions a conversation runs with, by the sandbox the user picked. */
export const extensionsFor = (
  choice: SandboxChoice,
  desktop: Extension = desktopExtension()
): Extension[] => {
  switch (choice) {
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
      throw new TypeError(`Unknown sandbox choice: ${choice satisfies never}`);
    }
  }
};

// Top-level conversation ids, in paged scans of one commit each; pages are sequential because each
// needs the previous cursor. Databases from before the subagent tool was removed can still hold its
// task-owned child conversations; they are skipped.
const scanTopLevel = async (
  harness: Harness,
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

const askIn = (conversation: Conversation, tracing: AgentTracing) =>
  Effect.fn("AgentConversation.ask")(function* (prompt: string) {
    yield* Effect.annotateCurrentSpan({
      "langfuse.observation.type": "agent",
      "langfuse.observation.input": prompt,
      "langfuse.session.id": tracing.sessionOf(conversation.id),
    });
    const answer = yield* tracing.traced(
      conversation.id,
      Effect.tryPromise({
        try: async () => {
          const submission = await conversation.submit(
            { type: "input", content: prompt },
            context
          );
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input") {
            throw new Error(`Run failed: ${settled.status}`);
          }
          return answerText(conversation, settled.answer);
        },
        catch: (cause) => new AgentError({ cause }),
      })
    );
    yield* Effect.annotateCurrentSpan("langfuse.observation.output", answer);
    return answer;
  });

const sendIn = (conversation: Conversation, tracing: AgentTracing) =>
  Effect.fn("AgentConversation.send")(function* (prompt: string) {
    yield* Effect.annotateCurrentSpan({
      "langfuse.observation.type": "agent",
      "langfuse.observation.input": prompt,
      "langfuse.session.id": tracing.sessionOf(conversation.id),
    });
    // Admitted without waiting: a busy conversation queues it as a follow-up, and the answer arrives as events.
    yield* tracing.traced(
      conversation.id,
      Effect.tryPromise({
        try: () =>
          conversation.submit(
            { type: "input", content: prompt, whenBusy: "followUp" },
            context
          ),
        catch: (cause) => new AgentError({ cause }),
      })
    );
  });

export interface AgentConversation {
  readonly id: ConversationId;
  /** The conversation's sandbox; `undefined` when started with `sandbox: "none"`. */
  readonly sandbox: SandboxInfo | undefined;
  ask(prompt: string): Effect.Effect<string, AgentError>;
  /** Send a prompt without waiting for the answer; it is queued as a follow-up while the agent runs. */
  send(prompt: string): Effect.Effect<void, AgentError>;
}

export class Agents extends Context.Service<
  Agents,
  {
    /** The model new conversations run on; /api/info reports it. */
    readonly model: AgentModel;
    /**
     * Start a conversation, creating its sandbox first. The sandbox is removed when the scope closes, so wrap a
     * conversation's lifetime in `Effect.scoped`.
     */
    start(options: {
      readonly sandbox: SandboxChoice;
      readonly title?: string;
      readonly createdAt?: number;
      readonly approvals?: ApprovalPolicy;
    }): Effect.Effect<
      AgentConversation,
      AgentError | SandboxError,
      Scope.Scope
    >;
    /**
     * Take an existing conversation — one persisted by a previous run — in a new scope. Creates no sandbox;
     * ended callers must check `meta.endedAt` first. Closing the scope aborts it, exactly like `start`'s.
     */
    attach(
      id: ConversationId
    ): Effect.Effect<
      AgentConversation,
      AgentError | ConversationNotFound,
      Scope.Scope
    >;
    /**
     * Record an approval decision on a conversation's doc. `always` also flips the policy to
     * `auto` and approves every other waiting call. Fails `ApprovalNotFound` when no call is waiting under `key`.
     */
    decide(
      id: ConversationId,
      key: string,
      decision: "approve" | "deny" | "always"
    ): Effect.Effect<void, AgentError | ApprovalNotFound>;
    /** Count of calls waiting for approval in a conversation. */
    pendingApprovals(id: ConversationId): Effect.Effect<number, AgentError>;
    /** Every stored top-level conversation that has metadata, newest last order irrelevant to callers. */
    readonly stored: Effect.Effect<readonly StoredConversation[], AgentError>;
    /** Record `meta.endedAt` for a conversation; unknown ids settle silently like other doc writes. */
    markEnded(id: ConversationId, at: number): Effect.Effect<void, AgentError>;
    /**
     * Watch a conversation: a `snapshot` first, then the events of every later commit.
     * The watch starts when this effect completes, so the stream is single-use and must be run: finishing or
     * interrupting it stops the watch, and a stream that is never run keeps it until the harness closes.
     */
    events(
      id: ConversationId
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /** The skills and MCP servers conversations can use, for the console. */
    readonly capabilities: Effect.Effect<Capabilities>;
    /**
     * Expand `/skill:` in a prompt (see `Skills.expand`): against conversation `id`'s skills when given, otherwise
     * against the skills a new conversation would get.
     */
    expandSkill(
      prompt: string,
      id?: ConversationId
    ): Effect.Effect<string, AgentError | SkillNotFound>;
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
          Effect.tryPromise({
            try: () =>
              Harness.open(
                options.storage ?? new MemoryStorage(),
                {
                  models: options.models,
                  registry,
                  // Every tool call runs in the sandbox its conversation recorded; without one there is no
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
              ),
            catch: (cause) => new AgentError({ cause }),
          }),
          (opened) => Effect.promise(() => opened.close(context))
        );

        // A run interrupted by a crash would resume against a sandbox that no longer exists, so every
        // conversation with live work is aborted before the service answers. The first `abort` enables
        // scheduling for the whole harness, so another conversation's pending task may start before its
        // own abort mark lands — at worst one tool call failing against a missing sandbox, or one model
        // request. Each abort waits until its conversation is idle.
        yield* Effect.tryPromise({
          try: async () => {
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
            // Pending approval entries left by a crash would show forever: the calls that created them
            // are aborted, so clear them (and now-meaningless decisions) on every stored conversation's doc.
            const records = await scanTopLevel(harness, undefined, []);
            await Promise.all(
              records.map((id) =>
                harness.commit(async (tx) => {
                  const doc = await tx.doc(ApprovalDoc, id);
                  doc.pending = {};
                  doc.decisions = {};
                }, context)
              )
            );
          },
          catch: (cause) => new AgentError({ cause }),
        });

        const start = Effect.fn("Agents.start")(function* (startOptions: {
          readonly sandbox: SandboxChoice;
          readonly title?: string;
          readonly createdAt?: number;
          readonly approvals?: ApprovalPolicy;
        }) {
          const choice = startOptions.sandbox;
          // This conversation's skills: the source as it is now, kept for its whole life.
          const conversationSkills = (yield* catalog).skills;
          const machine =
            choice === "none"
              ? undefined
              : yield* workspaces.sandbox({ level: choice });
          const sandbox = machine?.sandbox;
          const storage: StorageRef | undefined = machine?.storage;
          if (sandbox !== undefined && conversationSkills.length > 0) {
            yield* skills
              .install(workspaces.env(sandbox), conversationSkills, context)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SandboxError({
                      message: `Could not copy skills into ${sandbox.id}`,
                      cause,
                    })
                )
              );
          }
          // Acquired after the sandbox, so closing the scope stops the run and its queued inputs before the
          // sandbox is removed.
          const conversation = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                harness.createConversation(
                  {
                    ownership: { kind: "ownerless" },
                    agent: {
                      model: { ...options.model },
                      extensions: [
                        ...extensionsFor(choice, desktop),
                        ...(conversationSkills.length === 0 ? [] : [skillsExt]),
                        mcp.extension,
                        tracing.extension,
                      ],
                    },
                    // Recorded in the creating commit, so no tool call can run before the sandbox is known.
                    init: async (tx, id) => {
                      if (sandbox !== undefined) {
                        const doc = await tx.doc(SandboxDoc, id);
                        doc.sandbox = sandbox;
                      }
                      const workspace = await tx.doc(WorkspaceDoc, id);
                      workspace.level = choice;
                      if (storage !== undefined) {
                        workspace.storage = storage;
                      }
                      const skillsDoc = await tx.doc(SkillsDoc, id);
                      skillsDoc.skills = [...conversationSkills];
                      const meta = await tx.doc(MetaDoc, id);
                      meta.meta = {
                        title: startOptions.title ?? "",
                        sandbox: choice,
                        createdAt: startOptions.createdAt ?? Date.now(),
                      };
                      const approvals = await tx.doc(ApprovalDoc, id);
                      approvals.policy = startOptions.approvals ?? "auto";
                    },
                  },
                  context
                ),
              catch: (cause) => new AgentError({ cause }),
            }),
            (created) =>
              Effect.ignore(Effect.tryPromise(() => created.abort(context)))
          );
          return {
            id: conversation.id,
            sandbox,
            ask: askIn(conversation, tracing),
            send: sendIn(conversation, tracing),
          } satisfies AgentConversation;
        });

        // Same surface as `start`, without creating anything: the recorded conversation keeps its stored
        // sandbox reference, which is dead after a restart, so `sandbox` is `undefined` here.
        const attach = Effect.fn("Agents.attach")(function* (
          id: ConversationId
        ) {
          const handle = yield* Effect.tryPromise({
            try: () => harness.conversation(id, context),
            catch: (cause) => new AgentError({ cause }),
          });
          if (handle === undefined) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          yield* Effect.addFinalizer(() =>
            Effect.ignore(Effect.tryPromise(() => handle.abort(context)))
          );
          return {
            id: handle.id,
            sandbox: undefined,
            ask: askIn(handle, tracing),
            send: sendIn(handle, tracing),
          } satisfies AgentConversation;
        });

        const stored = Effect.gen(function* () {
          const all = yield* Effect.tryPromise({
            try: () => scanTopLevel(harness, undefined, []),
            catch: (cause) => new AgentError({ cause }),
          });

          const conversations: StoredConversation[] = [];
          for (const id of all) {
            const doc = yield* Effect.tryPromise({
              try: () => harness.snapshot(MetaDoc, id, context),
              catch: (cause) => new AgentError({ cause }),
            });
            if (doc?.meta !== undefined) {
              conversations.push({ id, meta: doc.meta });
            }
          }
          return conversations;
        }).pipe(Effect.withSpan("Agents.stored"));

        const markEnded = Effect.fn("Agents.markEnded")(function* (
          id: ConversationId,
          at: number
        ) {
          yield* Effect.tryPromise({
            try: () =>
              harness.commit(async (tx) => {
                const doc = await tx.doc(MetaDoc, id);
                const { meta } = doc;
                if (meta === undefined) {
                  return;
                }
                doc.meta = { ...meta, endedAt: at };
                // An ended conversation never needs approval again; the aborted calls' cleanup commits
                // land too late to clear these themselves.
                const approvals = await tx.doc(ApprovalDoc, id);
                approvals.pending = {};
                approvals.decisions = {};
              }, context),
            catch: (cause) => new AgentError({ cause }),
          });
        });

        const decide = Effect.fn("Agents.decide")(function* (
          id: ConversationId,
          key: string,
          decision: "approve" | "deny" | "always"
        ) {
          const found = yield* Effect.tryPromise({
            try: () =>
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
              }, context),
            catch: (cause) => new AgentError({ cause }),
          });
          if (!found) {
            return yield* new ApprovalNotFound({ key });
          }
        });

        const pendingApprovals = Effect.fn("Agents.pendingApprovals")(
          function* (id: ConversationId) {
            const count = yield* Effect.tryPromise({
              try: async () => {
                const doc = await harness.snapshot(ApprovalDoc, id, context);
                return Object.keys(doc?.pending ?? {}).length;
              },
              catch: (cause) => new AgentError({ cause }),
            });
            return count;
          }
        );

        const events = Effect.fn("Agents.events")(function* (
          id: ConversationId
        ) {
          // Only an existence check; the watch below reads the conversation itself.
          const handle = yield* Effect.tryPromise({
            try: () => harness.conversation(id, context),
            catch: (cause) => new AgentError({ cause }),
          });
          if (handle === undefined) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          // Attached now, not when the stream is run: events committed after this call are never missed. The attach
          // and wiring are uninterruptible, so an interrupt can never leave a watch without an owner; from then on
          // the stream's finalizer stops it.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
              const watch = yield* Effect.tryPromise({
                try: () => watchEvents(harness, id, context),
                catch: (cause) => new AgentError({ cause }),
              });
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

        const expandSkill = Effect.fn("Agents.expandSkill")(function* (
          prompt: string,
          id?: ConversationId
        ) {
          if (!prompt.includes("/skill:")) {
            return prompt;
          }
          const available =
            id === undefined
              ? (yield* catalog).skills
              : yield* Effect.tryPromise({
                  try: () => harness.snapshot(SkillsDoc, id, context),
                  catch: (cause) => new AgentError({ cause }),
                }).pipe(
                  Effect.flatMap((doc) =>
                    doc?.skills === undefined
                      ? catalog.pipe(Effect.map((c) => c.skills))
                      : Effect.succeed(doc.skills)
                  )
                );
          return yield* skills
            .expand(prompt, available)
            .pipe(
              Effect.catchTag("SkillSourceError", (cause) =>
                Effect.fail(new AgentError({ cause }))
              )
            );
        });

        return Agents.of({
          model: options.model,
          start,
          attach,
          decide,
          pendingApprovals,
          stored,
          markEnded,
          events,
          capabilities,
          expandSkill,
        });
      })
    );
}
