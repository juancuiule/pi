import type { Context as ChordContext } from "@earendil-works/chord";
// An Effect service over a pi-durable harness: how to run a Conversation. `create` records a new one, and `open`
// gives a Conversation a Seat (see GLOSSARY.md), with a Sandbox over its Workspace when its Level needs one. Which
// Conversations have Seats, and when that changes, is the server's concern (src/server/conversations.ts).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  Extension,
  Harness as HarnessType,
  Storage,
  SubmissionRecord,
  TaskId,
  ToolRegistration,
  Tx,
  UserInput,
  WatchHandle,
} from "@earendil-works/pi-durable";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  createRegistry,
  Harness,
  LiveDoc,
  MemoryStorage,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import type {
  AnswerInput,
  ApprovalChoice,
  ApprovalPolicy,
} from "../approvals.ts";
import {
  ApprovalDoc,
  bulkApprovable,
  clearApprovals,
  isGated,
  stopWaitingCalls,
} from "../approvals.ts";
import { Artifacts, artifactsExtension } from "../artifacts/artifacts.ts";
import { TrustedDomains } from "../artifacts/domains.ts";
import {
  Attachments,
  attachmentsExtension,
  copyToSandbox,
} from "../attachments/attachments.ts";
import type { LoadedAttachment } from "../attachments/attachments.ts";
import { escapeAttachmentTags, formatBlocks } from "../attachments/format.ts";
import { Capacity } from "../capacity.ts";
import type { Claim, ClaimCancelled } from "../capacity.ts";
import type {
  ConversationEvent,
  HistoryPage,
  UnansweredInput,
} from "../conversation-events.ts";
import type { StoredConversation } from "../conversation-meta.ts";
import { MetaDoc } from "../conversation-meta.ts";
import type {
  AttachmentNotFound,
  AttachmentRefused,
  CapacityExhausted,
  SkillNotFound,
} from "../errors.ts";
import {
  ApprovalNotFound,
  ConversationArchived,
  ConversationNotFound,
  EntryNotFound,
  InvalidSetting,
  InvalidUpgrade,
  SandboxUnavailable,
  TitleGenerationFailed,
  TraceUnavailable,
} from "../errors.ts";
import type { McpServerConfig, McpServerState } from "../mcp.ts";
import { connectMcpServers } from "../mcp.ts";
import type {
  ExposedPort,
  SandboxChoice,
  SandboxInfo,
  SandboxKind,
} from "../sandbox/sandbox.ts";
import { SandboxDoc, SandboxError } from "../sandbox/sandbox.ts";
import type { ShellSession } from "../sandbox/shell-session.ts";
import {
  checkSoftware,
  LEVEL_RANK,
  normalize,
  offered,
  SOFTWARE,
} from "../sandbox/software.ts";
import type { SoftwareId } from "../sandbox/software.ts";
import type { SaveScreenshot } from "../screenshots.ts";
import type { Skill } from "../skills/format.ts";
import { Skills, SkillsDoc, skillsExtension } from "../skills/skills.ts";
import type { SkillRemoveOutcome, SkillSaveOutcome } from "../skills/skills.ts";
import { CodingTools } from "../tools/bash.ts";
import { Calculator } from "../tools/calculator.ts";
import { desktopExtension } from "../tools/desktop.ts";
import { portsExtension } from "../tools/ports.ts";
import { questionsExtension } from "../tools/questions.ts";
import { workspaceExtension } from "../tools/workspace.ts";
import {
  generationAttributes,
  makeAgentTracing,
  TraceDoc,
  traceJson,
} from "../tracing.ts";
import { WebSearch, webSearchExtension } from "../web-search/web-search.ts";
import { WorkspaceDoc, Workspaces } from "../workspaces/workspaces.ts";
import type { StorageRef } from "../workspaces/workspaces.ts";
import { queueIfBusy, redecideQueuedMode } from "./admission.ts";
import {
  applyChange,
  changesBetween,
  describeSettings,
  isProblem,
  SETTINGS_ENTRY,
} from "./settings.ts";
import type {
  ConversationSettings,
  InstalledExtension,
  SettingsChange,
  SettingsProblem,
  SettingsRecord,
  SettingsState,
} from "./settings.ts";
import { capText, SOURCE_CAP, titleMessages, titleText } from "./title.ts";

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

/** History pages are capped so a transcript cannot be pulled whole in one request. */
const HISTORY_PAGE = 200;

// The hidden range is everything on the chain before the latest head marker's first retained entry; its `head`
// always resolves to a stored numeric id (`"self"` is rewritten when the marker is appended).
const earlierBound = async (
  tx: Tx,
  id: ConversationId
): Promise<EntryId | undefined> => {
  const head = await tx.latestHeadMarker(id);
  return head === undefined ? undefined : ((Number(head.head) - 1) as EntryId);
};

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  /** Waits for a person's decision when the conversation's approval policy is `ask`. */
  readonly approval: boolean;
}

export interface ExtensionInfo {
  readonly name: string;
  /** The Levels whose conversations select it. */
  readonly levels: readonly SandboxChoice[];
  readonly tools: readonly ToolInfo[];
  /** Keys of the system prompt sections it adds. */
  readonly sections: readonly string[];
  /** How many task hooks it installs (tracing's spans, for example). */
  readonly hooks: number;
  /** Always on: no conversation can switch it off. */
  readonly locked: boolean;
}

/** A conversation's settings, with the model and the prompt sections it runs with now. */
export interface ConversationAgent extends ConversationSettings {
  readonly model: string;
  /** Keys of the system prompt sections the agent gets now. */
  readonly sections: readonly string[];
}

export interface Capabilities {
  /** Every installed extension, with what it gives the agent. */
  readonly extensions: readonly ExtensionInfo[];
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    /** False for skills with `disable-model-invocation`: only `/skill:<name>` loads them. */
    readonly modelInvocable: boolean;
    /** Which namespace the folder's listed copy comes from. */
    readonly origin: "builtin" | "org" | "overridden";
    /** Every file in the skill's folder, `SKILL.md` first. */
    readonly files: readonly string[];
    /** The SKILL.md body after its frontmatter, for the console's skills page. */
    readonly body: string;
  }[];
  /** Skill folders the catalog skipped and why. */
  readonly skillProblems: readonly string[];
  readonly mcp: readonly McpServerState[];
  /** The Software this host offers, in catalog order, with the lowest Level that offers each. */
  readonly software: readonly {
    readonly id: SoftwareId;
    readonly label: string;
    readonly description: string;
    readonly level: SandboxKind;
  }[];
}

/** What an Upgrade asks for: a higher Level, more Software, or both. */
export interface UpgradeRequest {
  readonly level?: SandboxKind | undefined;
  readonly software?: readonly SoftwareId[] | undefined;
}

export interface AgentModel {
  readonly provider: string;
  readonly modelId: string;
}

// The skills a conversation could turn on: the source's now, and any it kept that the source dropped.
const skillCatalogOf = (
  source: readonly Skill[],
  kept: readonly Skill[]
): Skill[] => [
  ...source,
  ...kept.filter((skill) => !source.some((each) => each.name === skill.name)),
];

// A conversation's settings as they are stored, read inside a commit: the extensions it selects, the tools
// it leaves out, its skills, approval policy and Level.
const readState = async (
  tx: Tx,
  id: ConversationId,
  source: readonly Skill[]
) => {
  const agent = await tx.doc(AgentDoc, id);
  const skillsDoc = await tx.doc(SkillsDoc, id);
  const approvals = await tx.doc(ApprovalDoc, id);
  const workspace = await tx.doc(WorkspaceDoc, id);
  const kept: Skill[] = (skillsDoc.skills ?? []).map((skill) => ({
    ...skill,
    files: [...skill.files],
  }));
  const state: SettingsState = {
    level: workspace.level,
    approvals: approvals.policy,
    // Conversations this app creates select an array; another shape selects nothing it knows of.
    extensions: Array.isArray(agent.extensions) ? [...agent.extensions] : [],
    disabledTools:
      agent.tools === undefined || Array.isArray(agent.tools)
        ? []
        : [...agent.tools.remove],
    skills: kept.map((skill) => skill.name),
  };
  return { state, catalog: skillCatalogOf(source, kept) };
};

const LEVELS: readonly SandboxChoice[] = ["none", "shell", "desktop"];

const toolInfo = (tool: ToolRegistration): ToolInfo => ({
  name: tool.name,
  description: tool.description,
  approval: isGated(tool),
});

const portsOf = (target: {
  readonly ports: Map<number, { readonly exposed: ExposedPort }>;
}): ExposedPort[] => [...target.ports.values()].map((entry) => entry.exposed);

/** What the person reads when expose/close loses to a closed Sandbox or a failed publish. */
const portFailure = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  const tag =
    typeof failure === "object" && failure !== null && "_tag" in failure
      ? failure._tag
      : undefined;
  return new Error(
    tag === "SandboxUnavailable"
      ? "This conversation has no sandbox to publish a port from."
      : `The port could not be published: ${failure instanceof Error ? failure.message : String(failure)}`
  );
};

const upgradeTarget = (
  id: ConversationId,
  from: {
    readonly level: SandboxChoice;
    readonly software: readonly SoftwareId[];
  },
  asked: UpgradeRequest
) => {
  const level =
    asked.level !== undefined &&
    LEVEL_RANK[asked.level] > LEVEL_RANK[from.level]
      ? asked.level
      : from.level;
  const software = normalize([...from.software, ...(asked.software ?? [])]);
  const added = software.filter((each) => !from.software.includes(each));
  const problem = checkSoftware(level, software);
  if (
    level === "none" ||
    (level === from.level && added.length === 0) ||
    problem !== undefined
  ) {
    return new InvalidUpgrade({
      id: Number(id),
      from: from.level,
      to: asked.level ?? from.level,
      ...(problem === undefined ? {} : { reason: problem }),
    });
  }
  return { level, software, added };
};

/** The extensions a conversation runs with, by its Workspace's Level. */
export const extensionsFor = (
  level: SandboxChoice,
  desktop: Extension,
  ports: Extension
): Extension[] => {
  switch (level) {
    case "none": {
      return [Calculator];
    }
    case "shell": {
      return [Calculator, CodingTools, ports];
    }
    case "desktop": {
      return [Calculator, CodingTools, desktop, ports];
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
  /** Where this Seat's Workspace files are stored; `undefined` at Level `none`. */
  readonly storage: StorageRef | undefined;
  /** The Workspace's Level. */
  readonly level: SandboxChoice;
  /**
   * Raise the Level, add Software, or both: a Sandbox with the higher Level and the Software of both over the same
   * files replaces the current one, and a higher Level's tools are added. At a Capacity limit it fails, or with
   * `wait` waits until there is room (`Capacity.cancel` withdraws it).
   */
  upgrade(
    request: UpgradeRequest,
    options?: {
      readonly wait?: boolean;
      /** Who asked, for the conversation's record; the person, unless said otherwise. */
      readonly by?: "person" | "agent";
    }
  ): Effect.Effect<
    void,
    | AgentError
    | SandboxError
    | CapacityExhausted
    | ClaimCancelled
    | InvalidUpgrade
  >;
  /**
   * Send a prompt without waiting for the answer. While a Run is going it is queued: `steer` when the Run waits
   * on a person (an approval or `ask_user` card), so the same Run consumes it once the card resolves, `followUp`
   * while the Run works. `/skill:` is expanded against the conversation's skills first, in the prompt only; then
   * come the blocks of `attachments`, the conversation's unsent uploads, which are kept with it from then on.
   * `requestId` deduplicates the submission, which carries it; resolved with the admitted submission's record.
   */
  send(
    prompt: string,
    attachments?: readonly string[],
    requestId?: string
  ): Effect.Effect<
    SubmissionRecord,
    AgentError | SkillNotFound | AttachmentNotFound | AttachmentRefused
  >;
  /**
   * Send a prompt, with the conversation's unsent uploads in `attachments`, and wait for the answer's text; the model
   * requests and tool calls are traced under it.
   */
  ask(
    prompt: string,
    attachments?: readonly string[]
  ): Effect.Effect<string, AgentError | AttachmentNotFound | AttachmentRefused>;
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
    decision: ApprovalChoice
  ): Effect.Effect<void, AgentError | ApprovalNotFound>;
  /**
   * Answer an `ask_user` call with `answers`; without them its questions are skipped. Fails `ApprovalNotFound` when no
   * call is waiting for answers under `key`.
   */
  answer(
    key: string,
    answers?: readonly AnswerInput[]
  ): Effect.Effect<void, AgentError | ApprovalNotFound>;
  /** Count of calls waiting for approval or answers. */
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
  /**
   * The shared interactive shell session of this Seat's Sandbox, living for the Sandbox's lifetime rather
   * than the caller's: each caller gets an attach whose `output` replays recent scrollback then follows
   * live, and `write`/`resize` reach the same PTY. `SandboxUnavailable` when there is no Sandbox: Level
   * `none`, or mid-Upgrade while it is replaced.
   */
  shell(size: {
    readonly columns: number;
    readonly rows: number;
  }): Effect.Effect<ShellSession, SandboxError | SandboxUnavailable>;
  /**
   * The execution environment of this Seat's Sandbox, for host-side reads of the Workspace's files.
   * `SandboxUnavailable` when there is none: Level `none`, or mid-Upgrade while it is replaced.
   */
  readonly env: Effect.Effect<ExecutionEnv, SandboxUnavailable>;
  /**
   * Publish `input.port` of this Seat's Sandbox on a random host loopback port; the recorded
   * `ExposedPort` comes back. Idempotent per port: re-exposing returns the one already open.
   * `SandboxUnavailable` when there is no Sandbox: Level `none`, or mid-Upgrade while it is replaced.
   */
  exposePort(input: {
    readonly port: number;
    readonly label?: string;
  }): Effect.Effect<
    ExposedPort,
    AgentError | SandboxError | SandboxUnavailable
  >;
  /** Stop publishing `port`; a no-op when it is not open. */
  closePort(port: number): Effect.Effect<void, AgentError>;
  /**
   * This Seat's Sandbox as it comes, goes, and is replaced (Upgrade, Pause), starting with the current one.
   * Single-use, and must be run; finishing or interrupting it stops its watch.
   */
  readonly sandboxChanges: Effect.Effect<
    Stream.Stream<SandboxInfo | undefined, AgentError>,
    AgentError
  >;
}

export class Agents extends Context.Service<
  Agents,
  {
    /** The model new conversations run on; /api/info reports it. */
    readonly model: AgentModel;
    /** Whether conversations get generated titles: a real model is configured. */
    readonly titleGeneration: boolean;
    /** The extensions, skills and MCP servers conversations can use, for the console. */
    readonly capabilities: Effect.Effect<Capabilities>;
    /** What a conversation runs with now: its settings, model and prompt sections. */
    agent(
      id: ConversationId
    ): Effect.Effect<ConversationAgent, AgentError | ConversationNotFound>;
    /**
     * Turn a conversation's extensions, tools and skills on or off, or set its approval policy; it applies from the
     * agent's next model request. A skill turned on is copied into the conversation's Sandbox, when it has one.
     */
    configure(
      id: ConversationId,
      change: SettingsChange
    ): Effect.Effect<
      ConversationAgent,
      AgentError | ConversationNotFound | InvalidSetting | SandboxError
    >;
    /**
     * Record a new Conversation, with the skills the source has now. Fails `SkillNotFound`, creating nothing, when
     * `prompt` (its first prompt, sent later through its Seat) forces an unknown skill.
     */
    create(options: {
      readonly prompt: string;
      readonly title: string;
      readonly level: SandboxChoice;
      /** Installed in its Sandboxes on top of the Level's image; `InvalidSetting` when the Level cannot have it. */
      readonly software?: readonly SoftwareId[] | undefined;
      readonly createdAt: number;
      readonly approvals?: ApprovalPolicy | undefined;
      /** Changes to what a conversation at this Level gets by default. */
      readonly settings?: Omit<SettingsChange, "approvals"> | undefined;
    }): Effect.Effect<
      ConversationId,
      AgentError | SkillNotFound | InvalidSetting
    >;
    /**
     * Give a Conversation a Seat until the scope closes: a Sandbox over its Workspace when its Level needs one, with
     * its skills copied in. Closing the scope aborts the conversation, then removes the Sandbox; the Workspace's
     * files stay. Capacity is the caller's to claim.
     */
    open(
      id: ConversationId,
      options?: {
        /** The Level's resource, when the caller claimed it already; claimed here, without waiting, otherwise. */
        readonly levelClaim?: Claim;
      }
    ): Effect.Effect<
      Seat,
      | AgentError
      | SandboxError
      | ConversationNotFound
      | ConversationArchived
      | CapacityExhausted
      | ClaimCancelled,
      Scope.Scope
    >;
    /** Back to what a new conversation at its Level gets: extensions, tools and skills; the approval policy stays. */
    reset(
      id: ConversationId
    ): Effect.Effect<
      ConversationAgent,
      AgentError | ConversationNotFound | InvalidSetting | SandboxError
    >;
    /** Raise the Level, add Software, or both, for a Conversation without a Seat; its next Seat gets the Sandbox. */
    upgrade(
      id: ConversationId,
      request: UpgradeRequest
    ): Effect.Effect<void, AgentError | ConversationNotFound | InvalidUpgrade>;
    /** The person's rename: unconditional, marks the title "manual". Works paused or archived. */
    renameTitle(
      id: ConversationId,
      title: string
    ): Effect.Effect<StoredConversation, AgentError | ConversationNotFound>;
    /**
     * The one automatic title attempt after a run-end; a no-op unless eligible. Internal failures
     * are logged, not raised.
     */
    autoTitle(
      id: ConversationId
    ): Effect.Effect<void, AgentError | ConversationNotFound>;
    /** Explicit (re)generation — always allowed, unconditional apply, marks "generated". */
    generateTitle(
      id: ConversationId
    ): Effect.Effect<
      StoredConversation,
      AgentError | ConversationNotFound | TitleGenerationFailed
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
      Stream.Stream<ConversationEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /**
     * Transcript entries the latest head marker (a compaction or reset) hides from the active context, oldest
     * first. `before` pages back: pass the oldest id the caller holds to get the page that precedes it.
     */
    history(
      id: ConversationId,
      options?: { before?: number | undefined; limit?: number | undefined }
    ): Effect.Effect<HistoryPage, AgentError | ConversationNotFound>;
    /**
     * The OTEL trace id of the run that wrote an assistant entry — where its feedback is scored in Langfuse.
     * `EntryNotFound` for a missing or non-assistant entry; `TraceUnavailable` when its run left no trace.
     */
    entryTrace(
      id: ConversationId,
      entry: number
    ): Effect.Effect<
      string,
      AgentError | ConversationNotFound | EntryNotFound | TraceUnavailable
    >;
    /**
     * The conversation's transcript entries oldest first from `from` (an exclusive lower entry-id bound,
     * so callers pass a cursor verbatim), every kind, including what head markers hide — `history` serves
     * the console's bounded view, this serves the search indexer. Emitted lazily, one commit per page.
     */
    entries(
      id: ConversationId,
      options?: { from?: number | undefined }
    ): Effect.Effect<
      Stream.Stream<EntryRecord, AgentError>,
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
    /** Keep attachment text in traces; only its size by default. */
    readonly traceAttachmentText?: boolean | undefined;
    /** Generated titles, off unless passed `true` — production sets it when a real model is configured. */
    readonly titleGeneration?: boolean | undefined;
  }) =>
    Layer.effect(
      Agents,
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const capacity = yield* Capacity;
        const registry = createRegistry();
        // Each run's generation records its trace id into TraceDoc, so a message's feedback finds the run's
        // trace. Built before the harness like `skillEdits`, it is filled in once `harness` exists below.
        const traceWrites: {
          record?: (
            conversationId: ConversationId,
            taskId: TaskId,
            traceId: string,
            commitContext: ChordContext
          ) => Promise<void>;
        } = {};
        // Spans for model requests and tool calls use the tracer this layer is built with.
        const tracing = makeAgentTracing(yield* Effect.context<never>(), {
          attachmentText: options.traceAttachmentText === true,
          traceWrites,
        });
        registry.install(tracing.extension);
        const attachments = yield* Attachments;
        const artifacts = yield* Artifacts;
        // Skills are read from their source for every new conversation; the extension reads the conversation's.
        // Its write tools apply through the settings engine, defined at the end of this scope: `skillEdits`
        // is filled in once `changeSettings` exists, and a tool call resolves it long after the layer is built
        // (the `upgrades` map's late binding).
        const skills = yield* Skills;
        const skillEdits: {
          saved?: (
            id: ConversationId,
            name: string,
            outcome: SkillSaveOutcome
          ) => Effect.Effect<boolean, unknown>;
          deleted?: (
            id: ConversationId,
            name: string,
            outcome: SkillRemoveOutcome
          ) => Effect.Effect<boolean, unknown>;
        } = {};
        const skillsExt = skillsExtension(skills, {
          onSaved: (id, name, outcome) =>
            Effect.runPromise(
              skillEdits.saved === undefined
                ? Effect.die(new Error("skill edits are not wired"))
                : skillEdits.saved(id, name, outcome)
            ),
          onDeleted: (id, name, outcome) =>
            Effect.runPromise(
              skillEdits.deleted === undefined
                ? Effect.die(new Error("skill edits are not wired"))
                : skillEdits.deleted(id, name, outcome)
            ),
        });
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
        for (const extension of mcp.extensions) {
          registry.install(extension);
        }
        // The exposed-port ops of each conversation with a Seat, for the `expose_port` and `close_port`
        // tools. A missed id is a conversation without a Seat here, like `upgrades`.
        const exposes = new Map<
          ConversationId,
          {
            expose(input: {
              readonly port: number;
              readonly label?: string;
            }): Effect.Effect<ExposedPort, unknown>;
            close(port: number): Effect.Effect<void, unknown>;
          }
        >();
        const portsExt = portsExtension({
          expose: async (id, input, signal) => {
            const ops = exposes.get(id);
            if (ops === undefined) {
              throw new Error("This conversation is not running here.");
            }
            const exit = await Effect.runPromiseExit(
              ops.expose(input),
              signal === undefined ? {} : { signal }
            );
            if (Exit.isSuccess(exit)) {
              return { url: exit.value.url };
            }
            throw portFailure(exit.cause);
          },
          close: async (id, port, signal) => {
            const ops = exposes.get(id);
            // Nothing can be open without a Seat: closing stays a no-op.
            if (ops === undefined) {
              return;
            }
            const exit = await Effect.runPromiseExit(
              ops.close(port),
              signal === undefined ? {} : { signal }
            );
            if (Exit.isFailure(exit)) {
              throw portFailure(exit.cause);
            }
          },
        });
        const desktop = desktopExtension(
          options.saveScreenshot === undefined
            ? {}
            : { saveScreenshot: options.saveScreenshot }
        );
        for (const extension of extensionsFor("desktop", desktop, portsExt)) {
          registry.install(extension);
        }
        // The upgrade of each conversation with a Seat, for the `upgrade_workspace` tool.
        const upgrades = new Map<
          ConversationId,
          (request: UpgradeRequest) => Effect.Effect<void, unknown>
        >();
        const workspaceExt = workspaceExtension(async (id, level, signal) => {
          const upgrade = upgrades.get(id);
          if (upgrade === undefined) {
            throw new Error("This conversation is not running here.");
          }
          const exit = await Effect.runPromiseExit(
            upgrade({ level }),
            signal === undefined ? {} : { signal }
          );
          if (Exit.isSuccess(exit)) {
            return level === "desktop"
              ? "The workspace is now a desktop, with a shell and your files in /workspace."
              : "The workspace now has a shell; your files are in /workspace.";
          }
          const failure = Cause.squash(exit.cause);
          const tag =
            typeof failure === "object" && failure !== null && "_tag" in failure
              ? failure._tag
              : undefined;
          throw new Error(
            tag === "ClaimCancelled"
              ? "The person cancelled the upgrade."
              : `The upgrade failed: ${String(failure)}`
          );
        });
        registry.install(workspaceExt);
        // Whether a model takes images, so an attachment's image is only sent to one that does.
        const takesImages = (model: AgentModel | undefined) =>
          model !== undefined &&
          (options.models
            .getModel(model.provider, model.modelId)
            ?.input.includes("image") ??
            false);
        // Read and search over the conversation's attachments; always on, so a file once sent stays readable.
        const attachmentsExt = attachmentsExtension(attachments);
        registry.install(attachmentsExt);
        const artifactsExt = artifactsExtension(
          artifacts,
          yield* TrustedDomains
        );
        registry.install(artifactsExt);
        // `ask_user`: questions as a form in the console.
        const questionsExt = questionsExtension();
        registry.install(questionsExt);
        // Web search, only when the layer was given a WebSearch: `web_search` on the host at every Level. Not
        // locked — a conversation can switch it off.
        const webSearch = yield* Effect.serviceOption(WebSearch);
        const webExt =
          webSearch._tag === "Some"
            ? webSearchExtension(webSearch.value)
            : undefined;
        if (webExt !== undefined) {
          registry.install(webExt);
        }
        // Every installed extension, for the console; and those every conversation selects, whatever its Level.
        const installed = [
          ...extensionsFor("desktop", desktop, portsExt),
          workspaceExt,
          attachmentsExt,
          artifactsExt,
          questionsExt,
          ...(webExt === undefined ? [] : [webExt]),
          skillsExt,
          ...mcp.extensions,
          tracing.extension,
        ];
        const everyLevel = new Set<Extension>([
          workspaceExt,
          attachmentsExt,
          artifactsExt,
          questionsExt,
          ...(webExt === undefined ? [] : [webExt]),
          skillsExt,
          ...mcp.extensions,
          tracing.extension,
        ]);
        const isLocked = (extension: Extension) =>
          extension === tracing.extension ||
          extension === attachmentsExt ||
          extension === artifactsExt;
        const levelsOf = (extension: Extension) =>
          LEVELS.filter(
            (level) =>
              extensionsFor(level, desktop, portsExt).includes(extension) ||
              everyLevel.has(extension)
          );
        const installedInfo: InstalledExtension[] = installed.map(
          (extension) => ({
            name: extension.name,
            tools: (extension.tools ?? []).map(toolInfo),
            levels: levelsOf(extension),
            locked: isLocked(extension),
          })
        );
        const extensionByName = new Map(
          installed.map((extension) => [extension.name, extension] as const)
        );
        const toolByName = new Map(
          installed.flatMap((extension) =>
            (extension.tools ?? []).map((tool) => [tool.name, tool] as const)
          )
        );
        // What a conversation at `level` gets unless its settings say otherwise; the skills extension is
        // always among them — it also carries the write tools, so it is on even with no skills.
        const defaultExtensions = (level: SandboxChoice) =>
          [
            ...extensionsFor(level, desktop, portsExt),
            workspaceExt,
            attachmentsExt,
            artifactsExt,
            questionsExt,
            ...(webExt === undefined ? [] : [webExt]),
            skillsExt,
            ...mcp.extensions,
            tracing.extension,
          ].map((extension) => extension.name);
        // The agent change that selects a settings state's extensions and leaves out its disabled tools.
        const agentChangeFor = (state: SettingsState) => ({
          extensions: state.extensions.flatMap((name) => {
            const extension = extensionByName.get(name);
            return extension === undefined ? [] : [extension];
          }),
          tools:
            state.disabledTools.length === 0
              ? null
              : {
                  remove: state.disabledTools.flatMap((name) => {
                    const tool = toolByName.get(name);
                    return tool === undefined ? [] : [tool];
                  }),
                },
        });
        // Each Seat's current Sandbox, so a skill turned on can be copied into it.
        const seatSandboxes = new Map<
          ConversationId,
          () => SandboxInfo | undefined
        >();

        // Read directly only for what the harness does not expose: a conversation's unanswered inputs and recorded exchanges.
        const durableStorage = options.storage ?? new MemoryStorage();
        // The harness is opened when the layer is built and closed when it is torn down.
        const harness = yield* Effect.acquireRelease(
          attempt(() =>
            Harness.open(
              durableStorage,
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

        // Idempotent: the generation task's every request attempts the same key.
        traceWrites.record = (conversationId, taskId, traceId, commitContext) =>
          harness.commit(async (tx) => {
            const doc = await tx.doc(TraceDoc, conversationId);
            doc.traces[String(taskId)] ??= traceId;
          }, commitContext);

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
                approvals.answers = {};
                const sandbox = await tx.doc(SandboxDoc, id);
                delete sandbox.sandbox;
              }, context)
            )
          );
        });

        // Attachments claimed by a message when the server stopped: sent if the message was admitted, which its
        // submission (carrying the claim's id) shows, and free to send again otherwise.
        yield* attachments.settleClaims((conversationId, claim) =>
          attempt(() =>
            durableStorage.submissionByRequest(
              conversationId as ConversationId,
              // A requestId-named claim is scoped to its conversation; the submission keeps the bare id.
              claim.startsWith(`${conversationId}:`)
                ? claim.slice(`${conversationId}:`.length)
                : claim,
              context
            )
          ).pipe(Effect.map((submission) => submission !== undefined))
        );

        // The inputs of a conversation whose runs ended without an answer, in paged scans; pages are sequential
        // because each needs the previous cursor.
        const unansweredInputs = async (
          id: ConversationId,
          cursor?: Cursor,
          found: UnansweredInput[] = []
        ): Promise<UnansweredInput[]> => {
          const page = await durableStorage.scanSubmissions(
            { conversationId: id, status: "unanswered" },
            500,
            cursor,
            context
          );
          for (const record of page.items) {
            if (
              record.status === "unanswered" &&
              record.type === "input" &&
              record.entry !== undefined
            ) {
              found.push({
                entry: record.entry,
                reason: record.reason,
                ...(record.detail === undefined
                  ? {}
                  : { detail: record.detail }),
              });
            }
          }
          return page.next === undefined
            ? found
            : unansweredInputs(id, page.next, found);
        };

        const handleOf = Effect.fnUntraced(function* (id: ConversationId) {
          const handle = yield* attempt(() =>
            harness.conversation(id, context)
          );
          if (handle === undefined) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          return handle;
        });

        // The text of one submission side — the person's message, or the answer's text blocks — capped.
        const exchangeText = async (
          conversationId: ConversationId,
          entryId: EntryId
        ): Promise<string | undefined> => {
          const record = await durableStorage.entry(
            conversationId,
            entryId,
            context
          );
          const content = record?.entry.model?.[0]?.content;
          const text =
            typeof content === "string"
              ? content
              : (content ?? [])
                  .flatMap((c) => (c.type === "text" ? [c.text] : []))
                  .join("");
          return text === "" ? undefined : capText(text, SOURCE_CAP);
        };

        // The first or latest answered exchange with text to name a title from, in paged
        // scans; `done` also covers `write` submissions (settings records), so `input` is
        // filtered, and a record whose sides are both textless (an image-only message, an
        // empty answer) is passed over.
        const exchange = async (
          id: ConversationId,
          order: "ascending" | "descending",
          cursor?: Cursor
        ): Promise<
          | {
              readonly entry: EntryId;
              readonly user?: string;
              readonly answer?: string;
            }
          | undefined
        > => {
          const page = await durableStorage.scanSubmissions(
            { conversationId: id, status: "done", order },
            100,
            cursor,
            context
          );
          const found = await Promise.all(
            page.items
              .filter((item) => item.status === "done" && item.type === "input")
              .map(async (record) => {
                const [user, answer] = await Promise.all([
                  exchangeText(id, record.entry),
                  exchangeText(id, record.answer),
                ]);
                return user === undefined && answer === undefined
                  ? undefined
                  : {
                      entry: record.entry,
                      ...(user === undefined ? {} : { user }),
                      ...(answer === undefined ? {} : { answer }),
                    };
              })
          );
          return (
            found.find((each) => each !== undefined) ??
            (page.next === undefined
              ? undefined
              : exchange(id, order, page.next))
          );
        };

        // A one-shot completion outside the transcript, traced as a generation in the
        // conversation's Langfuse session. It resolves on provider errors, so the caller
        // reads `stopReason`.
        const completeTitle = (
          id: ConversationId,
          model: Model<Api>,
          messages: Message[]
        ) =>
          attempt(() =>
            options.models.completeSimple(
              model,
              { messages },
              { maxTokens: 1024, cacheRetention: "none" }
            )
          ).pipe(
            Effect.tap((message) =>
              Effect.annotateCurrentSpan(generationAttributes(message))
            ),
            Effect.withSpan("conversation title", {
              attributes: {
                "langfuse.observation.type": "generation",
                "langfuse.session.id": tracing.sessionOf(id),
                "langfuse.observation.input": traceJson(messages),
              },
            })
          );

        const conversationModel = (id: ConversationId) =>
          attempt(() => harness.snapshot(AgentDoc, id, context)).pipe(
            Effect.map((agent) =>
              agent?.model === undefined
                ? undefined
                : options.models.getModel(
                    agent.model.provider,
                    agent.model.modelId
                  )
            )
          );

        // The skills a conversation recorded; every conversation records them when it is created.
        const skillsOf = (id: ConversationId) =>
          attempt(() => harness.snapshot(SkillsDoc, id, context)).pipe(
            Effect.map((doc) => doc?.skills ?? [])
          );

        // With the skills extension off the conversation has no skills: a forced one is unknown, a mention is text.
        const skillsOn = (id: ConversationId) =>
          attempt(() => harness.snapshot(AgentDoc, id, context)).pipe(
            Effect.map(
              (agent) =>
                !Array.isArray(agent?.extensions) ||
                agent.extensions.includes(skillsExt.name)
            )
          );

        const expand = (prompt: string, id: ConversationId) =>
          prompt.includes("/skill:")
            ? Effect.all([skillsOf(id), skillsOn(id)]).pipe(
                Effect.map(([available, on]) => (on ? available : [])),
                Effect.flatMap((available) => skills.expand(prompt, available)),
                Effect.catchTag("SkillSourceError", (cause) =>
                  Effect.fail(new AgentError({ cause }))
                )
              )
            : Effect.succeed(prompt);

        // A message: the person's text, then a block per attachment, then the images when the model takes them.
        const messageContent = Effect.fnUntraced(function* (
          id: ConversationId,
          text: string,
          loaded: readonly LoadedAttachment[]
        ) {
          if (loaded.length === 0) {
            return text;
          }
          const agent = yield* attempt(() =>
            harness.snapshot(AgentDoc, id, context)
          );
          const images = takesImages(agent?.model);
          const blocks = formatBlocks(
            loaded.map((each) => ({
              info: each.record,
              prepared: each.prepared,
            })),
            { budget: attachments.limits.inlineChars, images }
          );
          const joined = [text, ...blocks]
            .filter((part) => part !== "")
            .join("\n\n");
          const imageParts = images
            ? yield* Effect.forEach(
                loaded.filter((each) => each.record.kind === "image"),
                (each) =>
                  attachments.file(each.record.id, Number(id), "model").pipe(
                    Effect.map(({ bytes }): ImageContent => ({
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: each.record.mediaType,
                    }))
                  )
              )
            : [];
          return imageParts.length === 0
            ? joined
            : [{ type: "text" as const, text: joined }, ...imageParts];
        });

        // Record a settings change in the conversation, where the console shows it; the model never sees it.
        const record = (id: ConversationId, entry: SettingsRecord) =>
          entry.changes.length === 0 && entry.reset !== true
            ? Effect.void
            : handleOf(id).pipe(
                Effect.flatMap((handle) =>
                  attempt(() =>
                    handle.submit(
                      {
                        type: "write",
                        entry: { kind: SETTINGS_ENTRY, data: entry },
                      },
                      context
                    )
                  )
                ),
                Effect.asVoid,
                // Bookkeeping: a record that cannot be written does not undo the change it describes.
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not record a settings change", cause)
                )
              );

        // Add extensions to a conversation's own selection, in one commit.
        const addExtensions = (
          id: ConversationId,
          added: readonly Extension[]
        ) =>
          attempt(() =>
            harness.commit(async (tx) => {
              const agent = await tx.doc(AgentDoc, id);
              const current = Array.isArray(agent.extensions)
                ? [...agent.extensions]
                : [];
              const missing = added
                .map((extension) => extension.name)
                .filter((name) => !current.includes(name));
              // Nothing is written when nothing is missing.
              if (missing.length > 0) {
                agent.extensions = [...current, ...missing];
              }
            }, context)
          );

        // Only the locked ones: a person's `skills: false` is durable. A pre-feature conversation lacking the
        // extension shows it off in settings, and can turn it on there — the skills extension installs at every
        // Level.
        const backfillAlwaysOnExtensions = (id: ConversationId) =>
          addExtensions(id, [attachmentsExt, artifactsExt]);

        // An Upgrade, recorded in the conversation and on its span for Langfuse.
        const recordUpgrade = (
          id: ConversationId,
          from: SandboxChoice,
          to: { readonly level: SandboxChoice; readonly added: SoftwareId[] },
          by: "person" | "agent"
        ) =>
          Effect.annotateCurrentSpan({
            "langfuse.observation.type": "event",
            "langfuse.session.id": tracing.sessionOf(id),
            "langfuse.observation.input": JSON.stringify({
              from,
              to: to.level,
              software: to.added,
              by,
            }),
          }).pipe(
            Effect.andThen(
              record(id, {
                by,
                changes: [
                  ...(from === to.level
                    ? []
                    : [{ type: "level" as const, from, to: to.level }]),
                  ...(to.added.length === 0
                    ? []
                    : [{ type: "software" as const, added: to.added }]),
                ],
              })
            )
          );

        // A conversation keeps the model it was created with. When this server does not have it (the configuration
        // changed since), the conversation moves to the configured model, recorded like a settings change, instead
        // of failing every request with `no_model`.
        const ensureModel = (id: ConversationId) =>
          Effect.gen(function* () {
            const configured = options.model;
            const available = (model: AgentModel | undefined) =>
              model !== undefined &&
              options.models.getModel(model.provider, model.modelId) !==
                undefined;
            if (!available(configured)) {
              return;
            }
            const from = yield* attempt(() =>
              harness.commit(async (tx) => {
                const agent = await tx.doc(AgentDoc, id);
                const current = agent.model;
                if (available(current)) {
                  return;
                }
                await configure(tx, id, { model: { ...configured } });
                return current === undefined
                  ? ""
                  : `${current.provider}/${current.modelId}`;
              }, context)
            );
            if (from === undefined) {
              return;
            }
            const to = `${configured.provider}/${configured.modelId}`;
            yield* Effect.logInfo(
              `Conversation ${id} moved to ${to}: ${from || "its model"} is not available`
            );
            yield* record(id, {
              by: "server",
              changes: [{ type: "model", from, to }],
            });
          });

        // One lock per conversation for what changes its settings or its Sandbox's skills: settings changes, Seats
        // opening and Upgrades. Commits are ordered anyway; the lock also orders what follows them (the Sandbox's
        // files, the records), so a later change never lands before an earlier one.
        const locks = new Map<ConversationId, Semaphore.Semaphore>();
        const locked = <A, E, R>(
          id: ConversationId,
          effect: Effect.Effect<A, E, R>
        ) =>
          Effect.suspend(() => {
            let lock = locks.get(id);
            if (lock === undefined) {
              lock = Semaphore.makeUnsafe(1);
              locks.set(id, lock);
            }
            return lock.withPermit(effect);
          });

        // Bring the Seat's Sandbox in line with the conversation's committed skills: replace the ones in `refresh`
        // (turned on, or every one on a reset) with the source's files, copy any enabled one whose folder is missing
        // (a copy that failed earlier), and delete the folders of `removed` and of other known skills. Each skill is
        // replaced from staged files, so a skill the source can no longer supply keeps its old copy; such problems
        // are logged rather than failing the change that led here.
        const reconcileSkills = Effect.fnUntraced(function* (
          id: ConversationId,
          sync: {
            readonly refresh: "all" | readonly string[];
            readonly removed: readonly string[];
          }
        ) {
          const sandbox = seatSandboxes.get(id)?.();
          if (sandbox === undefined) {
            return;
          }
          const env = workspaces.env(sandbox);
          const enabled = yield* skillsOf(id);
          const enabledNames = new Set(enabled.map((skill) => skill.name));
          const warn = (what: string) => (cause: unknown) =>
            Effect.logWarning(`${what} in ${sandbox.id}`, cause);
          // The commit that led here already landed, so a failed catalog read must not fail the change: the
          // change's `removed` still converge, the rest of the cleanup just skips.
          const catalogNames = yield* catalog.pipe(
            Effect.map((read) => read.skills.map((skill) => skill.name)),
            Effect.catchCause((cause) =>
              warn("Could not read the skills catalog")(cause).pipe(
                Effect.as<readonly string[]>([])
              )
            )
          );
          const known = new Set([...catalogNames, ...sync.removed]);
          const stale = [...known].filter((name) => !enabledNames.has(name));
          yield* skills
            .uninstall(env, stale, context)
            .pipe(Effect.catchCause(warn("Could not delete skills")));
          yield* Effect.forEach(
            enabled,
            (skill) =>
              Effect.gen(function* () {
                const refresh =
                  sync.refresh === "all" ||
                  sync.refresh.includes(skill.name) ||
                  !(yield* skills.isInstalled(env, skill.name, context));
                if (refresh) {
                  yield* skills.replace(env, skill, context);
                }
              }).pipe(
                Effect.catchCause(
                  warn(`Could not update the skill ${skill.name}`)
                )
              ),
            { discard: true }
          );
        });

        const create = Effect.fn("Agents.create")(function* (createOptions: {
          readonly prompt: string;
          readonly title: string;
          readonly level: SandboxChoice;
          readonly software?: readonly SoftwareId[] | undefined;
          readonly createdAt: number;
          readonly approvals?: ApprovalPolicy | undefined;
          readonly settings?: Omit<SettingsChange, "approvals"> | undefined;
        }) {
          const software = normalize(createOptions.software ?? []);
          const softwareProblem = checkSoftware(createOptions.level, software);
          if (softwareProblem !== undefined) {
            return yield* new InvalidSetting({
              name: "software",
              reason: softwareProblem,
            });
          }
          // This conversation's skills: the source as it is now, less any its settings turn off.
          const sourceSkills = (yield* catalog).skills;
          const settled = applyChange(
            installedInfo,
            sourceSkills,
            {
              level: createOptions.level,
              approvals: createOptions.approvals ?? "auto",
              extensions: defaultExtensions(createOptions.level),
              disabledTools: [],
              skills: sourceSkills.map((skill) => skill.name),
            },
            createOptions.settings ?? {}
          );
          if (isProblem(settled)) {
            return yield* new InvalidSetting(settled);
          }
          const conversationSkills = sourceSkills.filter((skill) =>
            settled.skills.includes(skill.name)
          );
          if (createOptions.prompt.includes("/skill:")) {
            yield* skills
              .expand(createOptions.prompt, conversationSkills)
              .pipe(
                Effect.catchTag("SkillSourceError", (cause) =>
                  Effect.fail(new AgentError({ cause }))
                )
              );
          }
          const { extensions: selected, tools: filtered } =
            agentChangeFor(settled);
          const created = yield* attempt(() =>
            harness.createConversation(
              {
                ownership: { kind: "ownerless" },
                agent: {
                  model: { ...options.model },
                  extensions: selected,
                  ...(filtered === null ? {} : { tools: filtered }),
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
                  if (software.length > 0) {
                    workspace.software = software;
                  }
                  const approvals = await tx.doc(ApprovalDoc, id);
                  approvals.policy = settled.approvals;
                },
              },
              context
            )
          );
          return created.id;
        });

        const open = Effect.fn("Agents.open")(function* (
          id: ConversationId,
          openOptions: { readonly levelClaim?: Claim } = {}
        ) {
          const handle = yield* handleOf(id);
          const meta = yield* attempt(() =>
            harness.snapshot(MetaDoc, id, context)
          );
          if (meta?.meta?.archivedAt !== undefined) {
            return yield* new ConversationArchived({ id: Number(id) });
          }
          yield* locked(id, ensureModel(id));
          yield* locked(id, backfillAlwaysOnExtensions(id));
          // A Seat's closing abort can leave pending entries whose calls are gone; while nothing runs nobody can
          // decide them, so they must not read as a person being waited on.
          yield* locked(
            id,
            attempt(() =>
              harness.commit(async (tx) => {
                const live = await tx.doc(LiveDoc, id);
                if (live.run !== undefined) {
                  return;
                }
                const approvals = await tx.doc(ApprovalDoc, id);
                if (
                  Object.keys(approvals.pending).length === 0 &&
                  Object.keys(approvals.decisions).length === 0 &&
                  Object.keys(approvals.answers ?? {}).length === 0
                ) {
                  return;
                }
                approvals.pending = {};
                approvals.decisions = {};
                approvals.answers = {};
              }, context)
            )
          );
          const workspace = yield* attempt(() =>
            harness.snapshot(WorkspaceDoc, id, context)
          );
          let level: SandboxChoice = workspace?.level ?? "none";
          let software: readonly SoftwareId[] = workspace?.software ?? [];
          let machine:
            | {
                readonly scope: Scope.Closeable;
                readonly sandbox: SandboxInfo;
                readonly storage: StorageRef;
                /** The ports this Sandbox publishes, by the sandbox port; each listener owns a child scope. */
                readonly ports: Map<
                  number,
                  {
                    readonly exposed: ExposedPort;
                    readonly scope: Scope.Closeable;
                  }
                >;
                shell?: ShellSession;
              }
            | undefined;
          let levelClaim: Scope.Closeable | undefined;
          let closing = false;
          const upgrading = yield* Semaphore.make(1);

          // One finalizer, in this order: the conversation stops, no tool call can find the Sandbox any more,
          // then the Sandbox goes and its claim is released. `closing` turns away an Upgrade queued behind it,
          // and taking `upgrading` lets one still landing finish first: `machine` and `levelClaim` then name
          // its new Sandbox and claim, and they close too.
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              closing = true;
              return Effect.gen(function* () {
                upgrades.delete(id);
                exposes.delete(id);
                seatSandboxes.delete(id);
                yield* Effect.ignore(attempt(() => handle.abort(context)));
                yield* Effect.ignore(
                  attempt(() =>
                    harness.commit(async (tx) => {
                      const doc = await tx.doc(SandboxDoc, id);
                      delete doc.sandbox;
                    }, context)
                  )
                );
                if (machine !== undefined) {
                  yield* Scope.close(machine.scope, Exit.void);
                }
                if (levelClaim !== undefined) {
                  yield* Scope.close(levelClaim, Exit.void);
                }
              }).pipe(upgrading.withPermit);
            })
          );

          const claimLevel = (
            to: SandboxKind,
            claimOptions: {
              readonly claim?: Claim | undefined;
              readonly wait?: boolean;
            }
          ) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const claim =
                claimOptions.claim ??
                (yield* capacity
                  .claim([to], {
                    holder: Number(id),
                    wait: claimOptions.wait ?? false,
                  })
                  .pipe(
                    Scope.provide(scope),
                    Effect.onError(() => Scope.close(scope, Exit.void))
                  ));
              yield* Scope.addFinalizer(scope, claim.release);
              return scope;
            });

          const attach = (
            to: SandboxKind,
            withSoftware: readonly SoftwareId[]
          ) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const attached = yield* Effect.exit(
                Effect.gen(function* () {
                  const current = yield* attempt(() =>
                    harness.snapshot(WorkspaceDoc, id, context)
                  );
                  const made = yield* workspaces.sandbox({
                    level: to,
                    software: withSoftware,
                    storage: current?.storage,
                  });
                  const conversationSkills = yield* skillsOf(id);
                  if (conversationSkills.length > 0) {
                    yield* skills
                      .install(
                        workspaces.env(made.sandbox),
                        conversationSkills,
                        context
                      )
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new SandboxError({
                              message: `Could not copy skills into ${made.sandbox.id}`,
                              cause,
                            })
                        )
                      );
                  }
                  // Sent attachments, for the shell's tools; a file that cannot be copied stays readable with the
                  // attachment tools.
                  yield* attachments.sent(Number(id)).pipe(
                    Effect.flatMap((sent) =>
                      copyToSandbox(
                        attachments,
                        workspaces.env(made.sandbox),
                        Number(id),
                        sent,
                        context
                      )
                    ),
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `Could not copy attachments into ${made.sandbox.id}`,
                        cause
                      )
                    )
                  );
                  // Recorded before anyone uses it, so no tool call of this Seat runs without its Sandbox.
                  yield* attempt(() =>
                    harness.commit(async (tx) => {
                      const doc = await tx.doc(SandboxDoc, id);
                      doc.sandbox = made.sandbox;
                      const files = await tx.doc(WorkspaceDoc, id);
                      files.level = to;
                      if (withSoftware.length > 0) {
                        files.software = [...withSoftware];
                      }
                      files.storage = made.storage;
                    }, context)
                  );
                  return made;
                }).pipe(Scope.provide(scope))
              );
              if (Exit.isFailure(attached)) {
                yield* Scope.close(scope, Exit.void);
                return yield* Effect.failCause(attached.cause);
              }
              return { scope, ...attached.value, ports: new Map() };
            });

          // What the Seat reports as its Sandbox: the created one, with the ports it has since opened.
          const liveSandbox = () => {
            const target = machine;
            if (target === undefined) {
              return;
            }
            const ports = portsOf(target);
            return ports.length === 0
              ? target.sandbox
              : { ...target.sandbox, ports };
          };

          // A port's listener lives on a child of `machine.scope`: `closePort` ends just that one, and
          // the Sandbox going (Upgrade, Pause, teardown) ends them all. `upgrading` serializes it with
          // Upgrade and the Seat's finalizer like `shell`.
          const exposePort = Effect.fn("Seat.exposePort")(
            function* (input: {
              readonly port: number;
              readonly label?: string;
            }) {
              const target = machine;
              if (closing || target === undefined) {
                return yield* new SandboxUnavailable({ id: Number(id) });
              }
              if (
                !Number.isInteger(input.port) ||
                input.port < 1 ||
                input.port > 65_535
              ) {
                return yield* new SandboxError({
                  message: "a port must be an integer in 1-65535",
                });
              }
              const existing = target.ports.get(input.port);
              if (existing !== undefined) {
                return existing.exposed;
              }
              const forked = yield* Scope.fork(target.scope);
              const published = yield* workspaces
                .expose(target.sandbox, input.port)
                .pipe(
                  Scope.provide(forked),
                  Effect.onError(() => Scope.close(forked, Exit.void))
                );
              const exposed: ExposedPort = {
                port: input.port,
                ...(input.label === undefined ? {} : { label: input.label }),
                url: published.url,
              };
              target.ports.set(input.port, { exposed, scope: forked });
              // Mirror the live ports onto this same Sandbox's record; on failure the listener
              // closes and the entry never lands.
              yield* attempt(() =>
                harness.commit(async (tx) => {
                  const doc = await tx.doc(SandboxDoc, id);
                  if (doc.sandbox?.id === target.sandbox.id) {
                    doc.sandbox = { ...doc.sandbox, ports: portsOf(target) };
                  }
                }, context)
              ).pipe(
                Effect.tapError(() =>
                  Effect.andThen(
                    Scope.close(forked, Exit.void),
                    Effect.sync(() => {
                      target.ports.delete(input.port);
                    })
                  )
                )
              );
              return exposed;
            },
            (effect) => upgrading.withPermit(effect)
          );

          const closePort = Effect.fn("Seat.closePort")(
            function* (port: number) {
              const target = machine;
              const existing = target?.ports.get(port);
              if (closing || target === undefined || existing === undefined) {
                return;
              }
              target.ports.delete(port);
              yield* Scope.close(existing.scope, Exit.void);
              yield* attempt(() =>
                harness.commit(async (tx) => {
                  const doc = await tx.doc(SandboxDoc, id);
                  if (doc.sandbox?.id === target.sandbox.id) {
                    doc.sandbox = { ...doc.sandbox, ports: portsOf(target) };
                  }
                }, context)
              );
            },
            (effect) => upgrading.withPermit(effect)
          );

          if (level !== "none") {
            levelClaim = yield* claimLevel(level, {
              claim: openOptions.levelClaim,
            });
            machine = yield* attach(level, software);
          }

          const upgrade = Effect.fn("Seat.upgrade")(
            function* (
              request: UpgradeRequest,
              upgradeOptions: {
                readonly wait?: boolean;
                readonly by?: "person" | "agent";
              } = {}
            ) {
              // The Seat is closing: a Sandbox made now would have nothing left to close it.
              if (closing) {
                return yield* new SandboxError({
                  message: `Conversation ${id}'s Seat is closing.`,
                });
              }
              const target = upgradeTarget(id, { level, software }, request);
              if (target instanceof InvalidUpgrade) {
                return yield* target;
              }
              const previous = machine;
              const added = extensionsFor(
                target.level,
                desktop,
                portsExt
              ).filter(
                (extension) =>
                  !extensionsFor(level, desktop, portsExt).includes(extension)
              );
              const claimed =
                target.level === level
                  ? undefined
                  : yield* claimLevel(target.level, {
                      wait: upgradeOptions.wait ?? false,
                    });
              machine = yield* attach(target.level, target.software).pipe(
                Effect.onError(() =>
                  claimed === undefined
                    ? Effect.void
                    : Scope.close(claimed, Exit.void)
                )
              );
              const replaced = claimed === undefined ? undefined : levelClaim;
              levelClaim = claimed ?? levelClaim;
              const from = level;
              ({ level, software } = target);
              yield* locked(
                id,
                addExtensions(id, added).pipe(
                  Effect.andThen(
                    recordUpgrade(
                      id,
                      from,
                      target,
                      upgradeOptions.by ?? "person"
                    )
                  ),
                  // A settings change during the Upgrade went to the old Sandbox.
                  Effect.andThen(
                    reconcileSkills(id, { refresh: [], removed: [] })
                  )
                )
              ).pipe(
                // The new Sandbox is recorded; the old one and the claim it replaced go, whatever happened above.
                Effect.ensuring(
                  Effect.gen(function* () {
                    if (previous !== undefined) {
                      yield* Scope.close(previous.scope, Exit.void);
                    }
                    if (replaced !== undefined) {
                      yield* Scope.close(replaced, Exit.void);
                    }
                  })
                )
              );
            },
            (effect) => upgrading.withPermit(effect)
          );
          upgrades.set(id, (request) =>
            upgrade(request, { wait: true, by: "agent" })
          );
          exposes.set(id, {
            expose: (input) => exposePort(input),
            close: (port) => closePort(port),
          });
          seatSandboxes.set(id, liveSandbox);
          // A settings change between the Sandbox's copy and this registration found no Sandbox to update.
          yield* locked(id, reconcileSkills(id, { refresh: [], removed: [] }));

          const annotate = (prompt: string) =>
            Effect.annotateCurrentSpan({
              "langfuse.observation.type": "agent",
              "langfuse.observation.input": prompt,
              "langfuse.session.id": tracing.sessionOf(id),
            });

          // Admit a message: `text`, then the conversation's unsent uploads in `ids`. The uploads are claimed first, so no
          // other message or removal takes them; the claim is committed exactly when the message is admitted (they are
          // sent from then on, and copied into the Sandbox) and released when it is not, so they can be sent again. The
          // admission and the commit cannot be interrupted apart; after a stop, the next start commits a claim whose
          // message was admitted (its submission carries the claim's id) and releases the others.
          //
          // With `busy: "steerWhenWaiting"` a send queues its own inbox item in one commit, so the queued mode reads
          // committed waiting state rather than a snapshot from before `submit`: `steer` while the run waits on a
          // person, `followUp` while it works. An idle conversation delegates to `handle.submit`, which owns the
          // run-starting admission.
          const admit = Effect.fnUntraced(function* (
            text: string,
            ids: readonly string[],
            busy?: "steerWhenWaiting",
            requestId?: string
          ) {
            // What the person typed can never pass for a block the server appended.
            const typed = escapeAttachmentTags(text);
            // A message with attachments carries its claim's id, stored with the submission when it is admitted.
            const submit = (content: UserInput, token?: string) =>
              attempt(async () => {
                if (busy !== "steerWhenWaiting") {
                  return handle.submit(
                    {
                      type: "input",
                      content,
                      ...(token === undefined ? {} : { requestId: token }),
                    },
                    context
                  );
                }
                harness.resume();
                const queued = await handle.commit(
                  (tx) => queueIfBusy(tx, id, content, token),
                  context
                );
                if (queued !== "idle") {
                  const known = await harness.submission(queued, context);
                  if (known === undefined) {
                    throw new Error(`Submission ${queued} does not exist`);
                  }
                  return known;
                }
                const submission = await handle.submit(
                  {
                    type: "input",
                    content,
                    ...(token === undefined ? {} : { requestId: token }),
                  },
                  context
                );
                // A run that went busy waiting on a person between the commit above and this submit queued the
                // item as `followUp`; while it is still queued, committed state decides its mode again.
                const status = await submission.status(context);
                if (status.status === "queued") {
                  await handle.commit(
                    (tx) => redecideQueuedMode(tx, id, submission.id),
                    context
                  );
                }
                return submission;
              });
            if (ids.length === 0) {
              return yield* submit(typed, requestId);
            }
            // A requestId already naming a submission is this send retried: answer with it instead of claiming
            // again — the claim would refuse the sent files, or commit new files no message references.
            if (requestId !== undefined) {
              const existing = yield* attempt(() =>
                durableStorage.submissionByRequest(id, requestId, context)
              );
              if (existing?.type === "input") {
                const known = yield* attempt(() =>
                  harness.submission(existing.id, context)
                );
                if (known !== undefined) {
                  return known;
                }
              }
            }
            yield* Effect.annotateCurrentSpan(
              "effect-pi.attachments",
              ids.join(",")
            );
            // The claim takes the request's id: the submission names it either way, so a restart settles it right.
            const claim = yield* attachments.claimForMessage(
              Number(id),
              ids,
              requestId
            );
            const content = yield* messageContent(id, typed, claim.loaded).pipe(
              Effect.onError(() => claim.release)
            );
            const submission = yield* Effect.uninterruptible(
              // The submission names the request's own id; the claim's is scoped, and settles through it.
              submit(content, requestId ?? claim.id).pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) ? claim.commit : claim.release
                )
              )
            );
            const sandbox = machine?.sandbox;
            if (sandbox !== undefined) {
              yield* copyToSandbox(
                attachments,
                workspaces.env(sandbox),
                Number(id),
                claim.loaded.map((each) => each.record),
                context
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `Could not copy attachments into ${sandbox.id}`,
                    cause
                  )
                )
              );
            }
            return submission;
          });

          const send = Effect.fn("Seat.send")(function* (
            prompt: string,
            attachmentIds: readonly string[] = [],
            requestId?: string
          ) {
            // Skills read only what the person typed, never a file's text.
            const expanded = yield* expand(prompt, id);
            yield* annotate(expanded);
            // Admitted without waiting: a busy conversation queues it, steering the run when it waits on a person
            // and as a follow-up while it works, and the answer arrives as events. No `tracing.traced`: the send
            // span ends at admission, before the run's task hooks — its spans adopt their own run root instead.
            const submission = yield* admit(
              expanded,
              attachmentIds,
              "steerWhenWaiting",
              requestId
            );
            return yield* attempt(() => submission.status(context));
          });

          const ask = Effect.fn("Seat.ask")(function* (
            prompt: string,
            attachmentIds: readonly string[] = []
          ) {
            yield* annotate(prompt);
            const answer = yield* tracing.traced(
              id,
              admit(prompt, attachmentIds).pipe(
                Effect.flatMap((submission) =>
                  attempt(async () => {
                    const settled = await submission.wait(context);
                    if (settled.status !== "done" || settled.type !== "input") {
                      throw new Error(`Run failed: ${settled.status}`);
                    }
                    return answerText(handle, settled.answer);
                  })
                )
              )
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
            decision: ApprovalChoice
          ) {
            const found = yield* attempt(() =>
              harness.commit(async (tx) => {
                const doc = await tx.doc(ApprovalDoc, id);
                const pending = doc.pending[key];
                if (pending === undefined || pending.question === true) {
                  return false;
                }
                if (decision === "always" && pending.personOnly !== true) {
                  // Parallel calls of the same round are already waiting; under `auto` none of them should.
                  // A personOnly card keeps asking every call: "always" on it decides like "approve".
                  doc.policy = "auto";
                  for (const [waiting, entry] of Object.entries(doc.pending)) {
                    if (bulkApprovable(entry)) {
                      doc.decisions[waiting] ??= "approve";
                    }
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

          const answer = Effect.fn("Seat.answer")(function* (
            key: string,
            answers?: readonly AnswerInput[]
          ) {
            const found = yield* attempt(() =>
              harness.commit(async (tx) => {
                const doc = await tx.doc(ApprovalDoc, id);
                if (
                  doc.pending[key]?.question !== true ||
                  doc.decisions[key] !== undefined
                ) {
                  return false;
                }
                if (answers === undefined) {
                  doc.decisions[key] = "deny";
                } else {
                  // Copied out: the doc stores plain JSON, not the caller's readonly arrays.
                  doc.answers = {
                    ...doc.answers,
                    [key]: answers.map((each) => ({
                      ...each,
                      selected: [...each.selected],
                    })),
                  };
                  doc.decisions[key] = "approve";
                }
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

          // The session lives on `machine.scope` — the Sandbox's lifetime — so a socket detaching does not
          // kill the PTY; `upgrading` serializes it with Upgrade and the Seat's finalizer like `upgrade` does.
          const shell = Effect.fn("Seat.shell")(function* (size: {
            readonly columns: number;
            readonly rows: number;
          }) {
            return yield* upgrading.withPermit(
              Effect.gen(function* () {
                const target = machine;
                if (closing || target === undefined) {
                  return yield* new SandboxUnavailable({ id: Number(id) });
                }
                let session = target.shell;
                if (session === undefined || !(yield* session.alive)) {
                  session = yield* workspaces
                    .shell(target.sandbox, size)
                    .pipe(Scope.provide(target.scope));
                  target.shell = session;
                }
                return session;
              })
            );
          });

          const env = Effect.suspend(() => {
            const target = machine?.sandbox;
            return target === undefined
              ? Effect.fail(new SandboxUnavailable({ id: Number(id) }))
              : Effect.succeed(workspaces.env(target));
          });

          const sandboxChanges = watchStream(
            () => harness.watchDoc(SandboxDoc, id, context),
            (doc) => doc?.sandbox
          ).pipe(
            Effect.map((stream) =>
              stream.pipe(
                // Recording a port rewrites the same Sandbox's doc; it neither comes nor goes, so a
                // consumer ending on the second emission (the console's shell) must not see it.
                Stream.changesWith((a, b) => a?.id === b?.id)
              )
            )
          );

          return {
            id,
            get sandbox() {
              return liveSandbox();
            },
            get storage() {
              return machine?.storage;
            },
            get level() {
              return level;
            },
            upgrade,
            send,
            ask,
            stop,
            decide,
            answer,
            pendingApprovals,
            running,
            changes,
            shell,
            env,
            exposePort,
            closePort,
            sandboxChanges,
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
            software: workspace?.software ?? [],
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
              approvals.answers = {};
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

        const upgradeStored = Effect.fn("Agents.upgrade")(function* (
          id: ConversationId,
          request: UpgradeRequest
        ) {
          yield* handleOf(id);
          const { from, target } = yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(WorkspaceDoc, id);
              const current = doc.level;
              const reached = upgradeTarget(
                id,
                { level: current, software: doc.software ?? [] },
                request
              );
              if (!(reached instanceof InvalidUpgrade)) {
                doc.level = reached.level;
                doc.software = [...reached.software];
              }
              return { from: current, target: reached };
            }, context)
          );
          if (target instanceof InvalidUpgrade) {
            return yield* target;
          }
          const added = extensionsFor(target.level, desktop, portsExt).filter(
            (extension) =>
              !extensionsFor(from, desktop, portsExt).includes(extension)
          );
          yield* locked(
            id,
            addExtensions(id, added).pipe(
              Effect.andThen(recordUpgrade(id, from, target, "person"))
            )
          );
        });

        const earlierOf = (id: ConversationId) =>
          harness.commit(async (tx): Promise<number | false> => {
            const bound = await earlierBound(tx, id);
            if (bound === undefined) {
              return false;
            }
            const page = await tx.scanEntries(
              { conversationId: id, maxEntryId: bound },
              1
            );
            return page.items.length === 0 ? false : bound;
          }, context);

        const history = Effect.fn("Agents.history")(function* (
          id: ConversationId,
          range: {
            before?: number | undefined;
            limit?: number | undefined;
          } = {}
        ) {
          yield* handleOf(id);
          return yield* attempt((): Promise<HistoryPage> =>
            harness.commit(async (tx) => {
              const bound = await earlierBound(tx, id);
              if (bound === undefined) {
                return { entries: [], earlier: false };
              }
              const requested = range.limit ?? Number.NaN;
              const limit = Number.isFinite(requested)
                ? Math.min(Math.max(requested, 1), HISTORY_PAGE)
                : HISTORY_PAGE;
              const max = (
                range.before === undefined
                  ? bound
                  : Math.min(range.before - 1, bound)
              ) as EntryId;
              // One extra row decides whether another page precedes this one; it is left off the page.
              const page = await tx.scanEntries(
                { conversationId: id, maxEntryId: max },
                limit + 1
              );
              const earlier = page.items.length > limit;
              return {
                entries: (earlier
                  ? page.items.slice(0, limit)
                  : page.items
                ).toReversed(),
                earlier,
              };
            }, context)
          );
        });

        // The trace an assistant entry's run was recorded under: where its Langfuse scores go. A committed
        // partial (an aborted run) has no `byTaskId`, and a run whose hook could not write has no row.
        const entryTrace = Effect.fn("Agents.entryTrace")(function* (
          id: ConversationId,
          entryId: number
        ) {
          yield* handleOf(id);
          const found = yield* attempt(() =>
            durableStorage.entry(id, entryId as EntryId, context)
          );
          if (
            found === undefined ||
            found.entry.model?.[0]?.role !== "assistant"
          ) {
            return yield* new EntryNotFound({ id: Number(id), entry: entryId });
          }
          const taskId = found.entry.byTaskId;
          if (taskId === undefined) {
            return yield* new TraceUnavailable({
              id: Number(id),
              entry: entryId,
              reason: "untraced",
            });
          }
          const doc = yield* attempt(() =>
            harness.snapshot(TraceDoc, id, context)
          );
          const traceId = doc?.traces[String(taskId)];
          if (traceId === undefined) {
            return yield* new TraceUnavailable({
              id: Number(id),
              entry: entryId,
              reason: "untraced",
            });
          }
          return traceId;
        });

        /** Transcript pages for the indexer; each page is one commit. */
        const ENTRIES_PAGE = 200;

        const entries = Effect.fn("Agents.entries")(function* (
          id: ConversationId,
          range: { readonly from?: number | undefined } = {}
        ) {
          yield* handleOf(id);
          const first =
            range.from === undefined
              ? undefined
              : ((range.from + 1) as EntryId);
          // Paged by entry id rather than the durable cursor: the bound is order-stable,
          // so a re-run from any cursor reads the same suffix.
          return Stream.paginate(first, (minEntryId) =>
            attempt(() =>
              harness.commit(
                (tx) =>
                  tx.scanEntries(
                    {
                      conversationId: id,
                      ...(minEntryId === undefined ? {} : { minEntryId }),
                      order: "ascending",
                    },
                    ENTRIES_PAGE
                  ),
                context
              )
            ).pipe(
              Effect.map((page) => {
                const last = page.items.at(-1);
                return [
                  page.items,
                  page.items.length < ENTRIES_PAGE || last === undefined
                    ? Option.none<EntryId>()
                    : Option.some((Number(last.id) + 1) as EntryId),
                ] as const;
              })
            )
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
              const queue = yield* Queue.unbounded<
                ConversationEvent,
                Cause.Done
              >();
              const watch = yield* attempt(() =>
                watchEvents(harness, id, context)
              );
              // Read after the watch attached: an input settled since arrives as a `submission` event as well.
              const settled = yield* Effect.exit(
                attempt(async () => ({
                  earlier: await earlierOf(id),
                  unanswered: await unansweredInputs(id),
                }))
              );
              if (Exit.isFailure(settled)) {
                yield* Effect.promise(() => watch.stop());
                return yield* Effect.failCause(settled.cause);
              }
              Queue.offerUnsafe(queue, {
                ...watch.snapshot,
                earlier: settled.value.earlier,
                unanswered: settled.value.unanswered,
              });
              // A watch that falls behind replaces its undelivered batches with a fresh snapshot, which gets the
              // unanswered inputs read again. Deliveries are awaited one at a time, so the order holds; a read that
              // fails ends the watch, and the stream with it.
              watch.start(async (batch) => {
                const delivered = await Promise.all(
                  batch.map(async (event): Promise<ConversationEvent> =>
                    event.type === "snapshot"
                      ? {
                          ...event,
                          earlier: await earlierOf(id),
                          unanswered: await unansweredInputs(id),
                        }
                      : event
                  )
                );
                Queue.offerAllUnsafe(queue, delivered);
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
          Effect.flatMap((current) =>
            Effect.map(
              Effect.all(
                current.skills.map((skill) =>
                  skills.body(skill).pipe(
                    Effect.map((body) => ({
                      name: skill.name,
                      description: skill.description,
                      modelInvocable: !skill.disableModelInvocation,
                      origin: skill.origin ?? "builtin",
                      files: skill.files,
                      body,
                    })),
                    Effect.mapError((cause) => new AgentError({ cause }))
                  )
                )
              ),
              (infos): Capabilities => ({
                skills: infos,
                skillProblems: current.problems,
                mcp: mcp.servers,
                software: offered("desktop").map((id) => ({
                  id,
                  label: SOFTWARE[id].label,
                  description: SOFTWARE[id].description,
                  level: SOFTWARE[id].level,
                })),
                extensions: installed.map((extension): ExtensionInfo => ({
                  name: extension.name,
                  levels: levelsOf(extension),
                  tools: (extension.tools ?? []).map(toolInfo),
                  sections: (extension.sections ?? []).map(
                    (section) => section.key
                  ),
                  hooks: extension.hooks?.length ?? 0,
                  locked: isLocked(extension),
                })),
              })
            )
          ),
          Effect.orDie
        );

        // Write a settings state: the agent's extensions and left-out tools, the skills, the approval policy.
        const writeState = async (
          tx: Tx,
          id: ConversationId,
          next: SettingsState,
          skillCatalog: readonly Skill[]
        ) => {
          await configure(tx, id, agentChangeFor(next));
          const skillsDoc = await tx.doc(SkillsDoc, id);
          skillsDoc.skills = skillCatalog.filter((skill) =>
            next.skills.includes(skill.name)
          );
          const approvals = await tx.doc(ApprovalDoc, id);
          approvals.policy = next.approvals;
          // Under `auto` nothing waits: calls already waiting are approved, as "always" does.
          if (next.approvals === "auto") {
            for (const [waiting, entry] of Object.entries(approvals.pending)) {
              if (bulkApprovable(entry)) {
                approvals.decisions[waiting] ??= "approve";
              }
            }
          }
        };

        const agentOf = Effect.fn("Agents.agent")(function* (
          id: ConversationId
        ) {
          const handle = yield* handleOf(id);
          const agent = yield* attempt(() => handle.agent(context));
          const source = (yield* catalog).skills;
          const { state, catalog: skillCatalog } = yield* attempt(() =>
            harness.commit((tx) => readState(tx, id, source), context)
          );
          return {
            ...describeSettings(installedInfo, skillCatalog, state),
            model:
              agent.model === undefined
                ? ""
                : `${agent.model.provider}/${agent.model.modelId}`,
            sections: agent.sections.map((section) => section.key),
          } satisfies ConversationAgent;
        });

        // Read, decide and write a conversation's settings in one commit; then match its Sandbox's skills to them,
        // record what changed, and annotate the span for Langfuse. All under the conversation's lock.
        // `refresh` re-reads named skills ("all" for every enabled one) into the Sandbox copy on top of the ones
        // the change turned on; `by` records who made it.
        const changeSettings = Effect.fnUntraced(
          function* (
            id: ConversationId,
            decide: (
              state: SettingsState,
              skillCatalog: readonly Skill[],
              source: readonly Skill[]
            ) => SettingsState | SettingsProblem,
            settingsOptions: {
              readonly reset?: boolean;
              readonly refresh?: "all" | readonly string[] | undefined;
              readonly by?: "person" | "agent";
            } = {}
          ) {
            yield* handleOf(id);
            const source = (yield* catalog).skills;
            const outcome = yield* attempt(() =>
              harness.commit(async (tx) => {
                const { state, catalog: skillCatalog } = await readState(
                  tx,
                  id,
                  source
                );
                const next = decide(state, skillCatalog, source);
                if (isProblem(next)) {
                  return { problem: next };
                }
                if (Array.isArray(settingsOptions.refresh)) {
                  const unknown = settingsOptions.refresh.find(
                    (name) => !skillCatalog.some((skill) => skill.name === name)
                  );
                  if (unknown !== undefined) {
                    return {
                      problem: { name: unknown, reason: "no such skill" },
                    };
                  }
                }
                await writeState(tx, id, next, skillCatalog);
                return {
                  changes: changesBetween(state, next),
                  turnedOn: next.skills.filter(
                    (name) => !state.skills.includes(name)
                  ),
                  removed: state.skills.filter(
                    (name) => !next.skills.includes(name)
                  ),
                };
              }, context)
            );
            if ("problem" in outcome) {
              return yield* new InvalidSetting(outcome.problem);
            }
            yield* Effect.annotateCurrentSpan({
              "langfuse.observation.type": "event",
              "langfuse.session.id": tracing.sessionOf(id),
              "langfuse.observation.output": JSON.stringify(outcome.changes),
            });
            yield* reconcileSkills(id, {
              refresh:
                settingsOptions.reset === true ||
                settingsOptions.refresh === "all"
                  ? "all"
                  : [...outcome.turnedOn, ...(settingsOptions.refresh ?? [])],
              removed: outcome.removed,
            });
            yield* record(id, {
              by: settingsOptions.by ?? "person",
              reset: settingsOptions.reset === true,
              changes: outcome.changes,
            });
            return yield* agentOf(id);
          },
          (effect, id) => locked(id, effect)
        );

        const configureSettings = Effect.fn("Agents.configure")(function* (
          id: ConversationId,
          change: SettingsChange
        ) {
          yield* Effect.annotateCurrentSpan(
            "langfuse.observation.input",
            JSON.stringify(change)
          );
          return yield* changeSettings(
            id,
            (state, skillCatalog) =>
              applyChange(installedInfo, skillCatalog, state, change),
            { refresh: change.refreshSkills }
          );
        });

        // Back to what a new conversation at its Level gets; the approval policy stays.
        const resetSettings = Effect.fn("Agents.reset")(function* (
          id: ConversationId
        ) {
          return yield* changeSettings(
            id,
            (state, _skillCatalog, source) => ({
              ...state,
              extensions: defaultExtensions(state.level),
              disabledTools: [],
              skills: source.map((skill) => skill.name),
            }),
            { reset: true }
          );
        });

        // The skill write tools' way into the settings engine: whether the calling conversation picked the write
        // up, so the tool's text can say. A saved "created" skill turns on here; an updated or shadowed one that
        // is on refreshes its copy; a deleted one that is on turns off; a reverted one refreshes to the built-in.
        const enabledSkill = Effect.fnUntraced(function* (
          id: ConversationId,
          name: string
        ) {
          const source = (yield* catalog).skills;
          return yield* attempt(() =>
            harness.commit(async (tx) => {
              const { state } = await readState(tx, id, source);
              return state.skills.includes(name);
            }, context)
          );
        });
        skillEdits.saved = (id, name, outcome) =>
          Effect.gen(function* () {
            if (outcome === "created") {
              yield* changeSettings(
                id,
                (state, skillCatalog) =>
                  applyChange(installedInfo, skillCatalog, state, {
                    skills: { [name]: true },
                  }),
                { refresh: [name], by: "agent" }
              );
              return true;
            }
            if (!(yield* enabledSkill(id, name))) {
              return false;
            }
            yield* changeSettings(id, (state) => state, {
              refresh: [name],
              by: "agent",
            });
            return true;
          });
        skillEdits.deleted = (id, name, outcome) =>
          Effect.gen(function* () {
            if (!(yield* enabledSkill(id, name))) {
              return false;
            }
            if (outcome === "removed") {
              // The deleted skill stays known through the kept-skill merge, so the toggle resolves.
              yield* changeSettings(
                id,
                (state, skillCatalog) =>
                  applyChange(installedInfo, skillCatalog, state, {
                    skills: { [name]: false },
                  }),
                { by: "agent" }
              );
              return true;
            }
            if (outcome === "reverted") {
              yield* changeSettings(id, (state) => state, {
                refresh: [name],
                by: "agent",
              });
              return true;
            }
            return false;
          });

        const renameTitle = Effect.fn("Agents.renameTitle")(function* (
          id: ConversationId,
          title: string
        ) {
          yield* handleOf(id);
          const trimmed = title.trim();
          const found = yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, id);
              if (doc.meta === undefined) {
                return false;
              }
              doc.meta = { ...doc.meta, title: trimmed, titleSource: "manual" };
              return true;
            }, context)
          );
          if (!found) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          return yield* get(id);
        });

        // One automatic attempt after a run-end: the latch and provenance are read first so a
        // spent or superseded title needs no scan or commit at all, the exchange check runs
        // before the claim so a run with no usable text never spends the latch, and
        // `autoTitleAt` is committed before the model call so the attempt is never retried.
        // A rename or regenerate that lands meanwhile is not stomped: the apply commits only
        // while the source still reads "prompt".
        const autoTitle = Effect.fn("Agents.autoTitle")(function* (
          id: ConversationId
        ) {
          if (options.titleGeneration !== true) {
            return;
          }
          yield* handleOf(id);
          const current = yield* attempt(() =>
            harness.snapshot(MetaDoc, id, context)
          );
          if (
            current?.meta === undefined ||
            (current.meta.titleSource ?? "prompt") !== "prompt" ||
            current.meta.autoTitleAt !== undefined
          ) {
            return;
          }
          const first = yield* attempt(() => exchange(id, "ascending"));
          // No exchange carries text yet: the attempt stays unspent for a run-end that does.
          if (first === undefined) {
            return;
          }
          const claimed = yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, id);
              const { meta } = doc;
              if (meta === undefined) {
                return "missing" as const;
              }
              if (
                (meta.titleSource ?? "prompt") !== "prompt" ||
                meta.autoTitleAt !== undefined
              ) {
                return "skip" as const;
              }
              doc.meta = { ...meta, autoTitleAt: Date.now() };
              return "claimed" as const;
            }, context)
          );
          if (claimed !== "claimed") {
            return;
          }
          const model = yield* conversationModel(id);
          if (model === undefined) {
            yield* Effect.logWarning(
              `Conversation ${id}: its model is not available for a title`
            );
            return;
          }
          const messages = titleMessages({
            firstUser: first.user,
            firstAnswer: first.answer,
          });
          const message = yield* completeTitle(id, model, messages);
          const title =
            message.stopReason === "stop" ? titleText(message) : undefined;
          if (title === undefined) {
            yield* Effect.logWarning(
              `Conversation ${id}: the model gave no usable title`
            );
            return;
          }
          yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, id);
              const { meta } = doc;
              if (
                meta === undefined ||
                (meta.titleSource ?? "prompt") !== "prompt"
              ) {
                return;
              }
              doc.meta = { ...meta, title, titleSource: "generated" };
            }, context)
          );
        });

        // An explicit (re)generation: unconditional apply — a click beats a manual title.
        const generateTitle = Effect.fn("Agents.generateTitle")(function* (
          id: ConversationId
        ) {
          yield* handleOf(id);
          if (options.titleGeneration !== true) {
            return yield* new TitleGenerationFailed({
              id: Number(id),
              reason: "no_model",
            });
          }
          const [first, latest] = yield* attempt(() =>
            Promise.all([exchange(id, "ascending"), exchange(id, "descending")])
          );
          if (first === undefined && latest === undefined) {
            return yield* new TitleGenerationFailed({
              id: Number(id),
              reason: "no_exchange",
            });
          }
          const model = yield* conversationModel(id);
          if (model === undefined) {
            return yield* new TitleGenerationFailed({
              id: Number(id),
              reason: "model_unavailable",
            });
          }
          const messages = titleMessages({
            firstUser: first?.user,
            firstAnswer: first?.answer,
            ...(latest !== undefined && latest.entry !== first?.entry
              ? {
                  latestUser: latest.user,
                  latestAnswer: latest.answer,
                }
              : {}),
          });
          const message = yield* completeTitle(id, model, messages);
          const title =
            message.stopReason === "stop" ? titleText(message) : undefined;
          if (title === undefined) {
            return yield* new TitleGenerationFailed({
              id: Number(id),
              reason: "model_error",
              ...(message.errorMessage === undefined
                ? {}
                : { message: message.errorMessage }),
            });
          }
          yield* attempt(() =>
            harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, id);
              const { meta } = doc;
              if (meta !== undefined) {
                doc.meta = { ...meta, title, titleSource: "generated" };
              }
            }, context)
          );
          return yield* get(id);
        });

        return Agents.of({
          model: options.model,
          titleGeneration: options.titleGeneration === true,
          capabilities,
          agent: agentOf,
          configure: configureSettings,
          reset: resetSettings,
          create,
          open,
          upgrade: upgradeStored,
          get,
          list,
          archive,
          unarchive,
          events,
          history,
          entryTrace,
          entries,
          renameTitle,
          autoTitle,
          generateTitle,
        });
      })
    );
}
