// oxlint-disable no-redeclare -- a schema and its type share a name, the Effect idiom
// The HTTP API, shared by the server and web/. Only type imports from pi packages: web/ bundles this file.
import { Context, Schema } from "effect";
import { Multipart } from "effect/http";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api";

import { ATTENTION_REASONS } from "../attention.ts";
import { SESSION_COOKIE, User } from "../auth/user.ts";
import {
  ApprovalNotFound,
  ArtifactNotFound,
  AttachmentNotFound,
  AttachmentRefused,
  CapacityExhausted,
  ConversationArchived,
  ConversationNotFound,
  EmptyMessage,
  EntryNotFound,
  InvalidAccount,
  InvalidCredentials,
  InvalidDomain,
  InvalidSetting,
  InvalidSkill,
  InvalidUpgrade,
  SandboxUnavailable,
  SetupClosed,
  SkillNotFound,
  SubmissionNotFound,
  TitleGenerationFailed,
  TooManyAttempts,
  TraceUnavailable,
  Unauthorized,
  WorkspaceFileNotFound,
} from "../errors.ts";
import { SOFTWARE_IDS } from "../sandbox/software.ts";

export { SOFTWARE } from "../sandbox/software.ts";
export {
  NAME_RULE,
  nameProblem,
  PASSWORD_RULE,
  passwordProblem,
  User,
  UserId,
} from "../auth/user.ts";

export type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
export type {
  ConversationEvent,
  ConversationSnapshot,
  HistoryPage,
  QueuedInput,
  UnansweredInput,
} from "../conversation-events.ts";
export type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  ToolSlot,
  UsageState,
} from "@earendil-works/pi-durable";
export {
  ApprovalNotFound,
  ArtifactNotFound,
  AttachmentNotFound,
  AttachmentRefused,
  CapacityExhausted,
  ConversationArchived,
  ConversationNotFound,
  EmptyMessage,
  EntryNotFound,
  InvalidAccount,
  InvalidCredentials,
  InvalidDomain,
  InvalidSetting,
  InvalidSkill,
  InvalidUpgrade,
  SandboxUnavailable,
  SetupClosed,
  SkillNotFound,
  SubmissionNotFound,
  TitleGenerationFailed,
  TooManyAttempts,
  TraceUnavailable,
  Unauthorized,
  WorkspaceFileNotFound,
} from "../errors.ts";

export const SandboxChoice = Schema.Literals(["none", "shell", "desktop"]);
export type SandboxChoice = typeof SandboxChoice.Type;

export const SoftwareId = Schema.Literals(SOFTWARE_IDS);
export type SoftwareId = typeof SoftwareId.Type;

export const AttentionReason = Schema.Literals(ATTENTION_REASONS);
export type AttentionReason = typeof AttentionReason.Type;

/** The last settled input ended badly — why the conversation needs the person. */
export const Attention = Schema.Struct({
  reason: AttentionReason,
  detail: Schema.optionalKey(Schema.String),
});
export type Attention = typeof Attention.Type;

export const ApprovalChoice = Schema.Literals(["approve", "deny", "always"]);
export type ApprovalChoice = typeof ApprovalChoice.Type;

/** A person's answer to one `ask_user` question: the options picked, and their own text. */
export const QuestionAnswer = Schema.Struct({
  id: Schema.String,
  selected: Schema.Array(Schema.String),
  other: Schema.optionalKey(Schema.String),
});
export type QuestionAnswer = typeof QuestionAnswer.Type;

export const ConversationSummary = Schema.Struct({
  id: Schema.Number,
  sandbox: SandboxChoice,
  /** Installed in its Sandboxes on top of the Level's image, in catalog order. */
  software: Schema.Array(SoftwareId),
  sandboxId: Schema.optionalKey(Schema.String),
  /** The Sandbox has a desktop to watch, over the `/api/conversations/:id/desktop` WebSocket. */
  desktop: Schema.optionalKey(Schema.Boolean),
  title: Schema.String,
  /** `running` and `idle` have a Seat; `paused` and `archived` do not. */
  status: Schema.Literals(["running", "idle", "paused", "archived"]),
  /** True while a Pause waits for the current Run to end. */
  pausing: Schema.Boolean,
  createdAt: Schema.Number,
  pendingApprovals: Schema.Number,
  attention: Schema.optionalKey(Attention),
});
export type ConversationSummary = typeof ConversationSummary.Type;

/** A file uploaded for a message, checked and prepared (see docs/adr/0002-attachments-prepared-at-upload.md). */
export const AttachmentInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  kind: Schema.Literals(["text", "html", "pdf", "table", "image", "file"]),
  size: Schema.Number,
  /** `partial`: some PDF pages need OCR; `needs_ocr`: none has text. */
  status: Schema.Literals(["ready", "partial", "needs_ocr"]),
  pages: Schema.optionalKey(Schema.Number),
  chars: Schema.optionalKey(Schema.Number),
  ocrPages: Schema.Array(Schema.Number),
  warnings: Schema.Array(Schema.String),
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  /** Tables: rows after the header, and the header's columns. */
  rows: Schema.optionalKey(Schema.Number),
  columns: Schema.optionalKey(Schema.Number),
  createdAt: Schema.Number,
});
export type AttachmentInfo = typeof AttachmentInfo.Type;

/** What was prepared from an attachment: what the model reads (see src/attachments/format.ts `Prepared`). */
export const PreparedAttachment = Schema.Struct({
  kind: Schema.Literals(["text", "html", "pdf", "table", "image", "file"]),
  /** One entry per PDF page; a single one for text, HTML and tables (one line per row); none for images and binary files. */
  pages: Schema.Array(Schema.String),
  ocrPages: Schema.Array(Schema.Number),
  warnings: Schema.Array(Schema.String),
  extractor: Schema.String,
  image: Schema.optionalKey(
    Schema.Struct({ width: Schema.Number, height: Schema.Number })
  ),
  table: Schema.optionalKey(
    Schema.Struct({
      rows: Schema.Number,
      columns: Schema.Number,
      delimiter: Schema.String,
    })
  ),
});
export type PreparedAttachment = typeof PreparedAttachment.Type;

export const ToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Waits for a person's decision under the `ask` approval policy. */
  approval: Schema.Boolean,
});
export type ToolInfo = typeof ToolInfo.Type;

const Toggles = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.Boolean)
);

/** Each entry turns one extension, tool or skill on (`true`) or off (`false`). */
export const SettingsChange = Schema.Struct({
  approvals: Schema.optionalKey(Schema.Literals(["ask", "auto"])),
  extensions: Toggles,
  tools: Toggles,
  skills: Toggles,
  /** Re-read these skills from the source into the conversation's state and Sandbox copies; "all" for every enabled one. */
  refreshSkills: Schema.optionalKey(
    Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)])
  ),
});
export type SettingsChange = typeof SettingsChange.Type;

/** A conversation's settings, and the model and prompt sections it runs with now. */
export const ConversationAgent = Schema.Struct({
  model: Schema.String,
  level: SandboxChoice,
  approvals: Schema.Literals(["ask", "auto"]),
  extensions: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      enabled: Schema.Boolean,
      /** False when the Level does not allow it; it can then only be off. */
      available: Schema.Boolean,
      locked: Schema.Boolean,
      tools: Schema.Array(
        Schema.Struct({ ...ToolInfo.fields, enabled: Schema.Boolean })
      ),
    })
  ),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      enabled: Schema.Boolean,
    })
  ),
  sections: Schema.Array(Schema.String),
});
export type ConversationAgent = typeof ConversationAgent.Type;

export const Capabilities = Schema.Struct({
  extensions: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      levels: Schema.Array(SandboxChoice),
      tools: Schema.Array(ToolInfo),
      sections: Schema.Array(Schema.String),
      hooks: Schema.Number,
      /** Always on: it cannot be switched off. */
      locked: Schema.Boolean,
    })
  ),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      modelInvocable: Schema.Boolean,
      /** `builtin` from the repository, `org` written at runtime, `overridden` an org copy shadowing a builtin. */
      origin: Schema.Literals(["builtin", "org", "overridden"]),
      /** Every file in the skill's folder, `SKILL.md` first. */
      files: Schema.Array(Schema.String),
      /** The SKILL.md body after its frontmatter, for the console's skills page. */
      body: Schema.String,
    })
  ),
  /** Skill folders the catalog skipped and why. */
  skillProblems: Schema.Array(Schema.String),
  mcp: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      status: Schema.Literals(["connected", "unavailable"]),
      error: Schema.optionalKey(Schema.String),
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, description: Schema.String })
      ),
    })
  ),
  /** The Software this host offers, in catalog order; `level` is the lowest Level that offers each. */
  software: Schema.Array(
    Schema.Struct({
      id: SoftwareId,
      label: Schema.String,
      description: Schema.String,
      level: Schema.Literals(["shell", "desktop"]),
    })
  ),
});
export type Capabilities = typeof Capabilities.Type;

export const CapacityUsage = Schema.Struct({
  resource: Schema.Literals(["seat", "shell", "desktop"]),
  limit: Schema.Number,
  /** How many are held, by anyone: the limit is shared by every User. */
  inUse: Schema.Number,
  /** The caller's own Conversations holding one; other people's are counted in `inUse` only. */
  holders: Schema.Array(Schema.Number),
  /** Conversations waiting for one: an agent's Upgrade waits until there is room. */
  waiting: Schema.Array(Schema.Number),
});
export type CapacityUsage = typeof CapacityUsage.Type;

const UnknownSkill = SkillNotFound.pipe(HttpApiSchema.status(400));
const NotFound = ConversationNotFound.pipe(HttpApiSchema.status(404));
const Full = CapacityExhausted.pipe(HttpApiSchema.status(409));
const Archived = ConversationArchived.pipe(HttpApiSchema.status(409));
const Invalid = InvalidSetting.pipe(HttpApiSchema.status(400));
const ById = { id: Schema.Int };
const Empty = EmptyMessage.pipe(HttpApiSchema.status(400));
const Refused = AttachmentRefused.pipe(HttpApiSchema.status(400));
const NoAttachment = AttachmentNotFound.pipe(HttpApiSchema.status(404));
const NoSubmission = SubmissionNotFound.pipe(HttpApiSchema.status(404));
const NoEntry = EntryNotFound.pipe(HttpApiSchema.status(404));
const NoTrace = TraceUnavailable.pipe(HttpApiSchema.status(409));
/** Text, attachments (ids of uploads), or both. */
const MessageFields = {
  prompt: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The sender's deduplication key: the admitted submission carries it, and resubmitting it is a no-op. */
  requestId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
};

/** The input a message was admitted as: its submission, and the entry once it is placed. */
export const SubmissionAck = Schema.Struct({
  id: Schema.Number,
  /** A retried request can answer with an already-settled submission. */
  status: Schema.Literals(["queued", "placed", "done", "unanswered"]),
  entry: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
export type SubmissionAck = typeof SubmissionAck.Type;

const ConversationGroup = HttpApiGroup.make("conversations").add(
  HttpApiEndpoint.get("list", "/conversations", {
    success: Schema.Array(ConversationSummary),
  }),
  HttpApiEndpoint.post("create", "/conversations", {
    payload: Schema.Struct({
      sandbox: SandboxChoice,
      software: Schema.optionalKey(Schema.Array(SoftwareId)),
      ...MessageFields,
      approvals: Schema.optionalKey(Schema.Literals(["ask", "auto"])),
      /** Changes to what a conversation at this Level gets by default. */
      settings: Schema.optionalKey(
        Schema.Struct({
          extensions: Toggles,
          tools: Toggles,
          skills: Toggles,
        })
      ),
    }),
    success: Schema.Struct({
      ...ConversationSummary.fields,
      submission: SubmissionAck,
    }).pipe(HttpApiSchema.status(201)),
    error: [Full, UnknownSkill, Invalid, Empty, Refused, NoAttachment],
  }),
  HttpApiEndpoint.post("send", "/conversations/:id/messages", {
    params: ById,
    payload: Schema.Struct(MessageFields),
    success: SubmissionAck,
    error: [
      NotFound,
      Full,
      Archived,
      UnknownSkill,
      Empty,
      Refused,
      NoAttachment,
    ],
  }),
  // Take back a message still queued behind a run; `placed`/`settled` say it already went in.
  HttpApiEndpoint.post(
    "withdraw",
    "/conversations/:id/messages/:submission/withdraw",
    {
      params: { id: Schema.Int, submission: Schema.Int },
      success: Schema.Struct({
        outcome: Schema.Literals(["withdrawn", "placed", "settled"]),
      }),
      error: [NotFound, NoSubmission],
    }
  ),
  // What the conversation runs with now: its settings, model and prompt sections.
  HttpApiEndpoint.get("agent", "/conversations/:id/agent", {
    params: ById,
    success: ConversationAgent,
    error: NotFound,
  }),
  // Back to what a new conversation at its Level gets; the approval policy stays.
  HttpApiEndpoint.post("reset", "/conversations/:id/agent/reset", {
    params: ById,
    success: ConversationAgent,
    error: [NotFound, Invalid],
  }),
  // Turn extensions, tools and skills on or off, or set the approval policy; applies from the next model request.
  HttpApiEndpoint.patch("configure", "/conversations/:id/agent", {
    params: ById,
    payload: SettingsChange,
    success: ConversationAgent,
    error: [NotFound, Invalid],
  }),
  // One ConversationEvent per SSE message: a snapshot first, then each commit's events.
  HttpApiEndpoint.get("events", "/conversations/:id/events", {
    params: ById,
    success: HttpApiSchema.StreamSse({ data: Schema.Json }),
    error: NotFound,
  }),
  // Entries a head marker (a compaction or reset) hides from the active context, oldest first; `before` pages back
  // from an entry id. Entries are storage records, typed for clients as `HistoryPage`.
  HttpApiEndpoint.get("history", "/conversations/:id/history", {
    params: ById,
    query: {
      before: Schema.optionalKey(Schema.FiniteFromString),
      limit: Schema.optionalKey(Schema.FiniteFromString),
    },
    success: Schema.Struct({
      entries: Schema.Array(Schema.Unknown),
      earlier: Schema.Boolean,
    }),
    error: NotFound,
  }),
  // Give a paused Conversation a Seat, or cancel a Pause waiting for the Run of one that has a Seat.
  HttpApiEndpoint.post("resume", "/conversations/:id/resume", {
    params: ById,
    success: ConversationSummary,
    error: [NotFound, Full, Archived],
  }),
  // Free the Seat: at once when idle, otherwise once the current Run ends.
  HttpApiEndpoint.post("pause", "/conversations/:id/pause", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  // Abort the current Run; the Seat stays.
  HttpApiEndpoint.post("stop", "/conversations/:id/stop", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  // Raise the Level, add Software, or both; with a Seat, now, if there is room.
  HttpApiEndpoint.post("upgrade", "/conversations/:id/upgrade", {
    params: ById,
    payload: Schema.Struct({
      level: Schema.optionalKey(Schema.Literals(["shell", "desktop"])),
      software: Schema.optionalKey(Schema.Array(SoftwareId)),
    }),
    success: ConversationSummary,
    error: [
      NotFound,
      Full,
      Archived,
      InvalidUpgrade.pipe(HttpApiSchema.status(400)),
    ],
  }),
  // Withdraw the agent's Upgrade waiting for room; it ends with an error the agent sees.
  HttpApiEndpoint.post("cancelWait", "/conversations/:id/upgrade/cancel", {
    params: ById,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.post("archive", "/conversations/:id/archive", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  HttpApiEndpoint.post("unarchive", "/conversations/:id/unarchive", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  // The person's rename: marks the title manual; automation never touches it again.
  HttpApiEndpoint.post("rename", "/conversations/:id/rename", {
    params: ById,
    payload: Schema.Struct({
      title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    }),
    success: ConversationSummary,
    error: NotFound,
  }),
  // Regenerate the title with the conversation's model; an explicit click beats "manual".
  HttpApiEndpoint.post("generateTitle", "/conversations/:id/generate-title", {
    params: ById,
    success: ConversationSummary,
    error: [NotFound, TitleGenerationFailed.pipe(HttpApiSchema.status(409))],
  }),
  HttpApiEndpoint.post("approvals", "/conversations/:id/approvals", {
    params: ById,
    payload: Schema.Struct({
      key: Schema.String,
      decision: ApprovalChoice,
    }),
    success: HttpApiSchema.NoContent,
    error: [NotFound, ApprovalNotFound.pipe(HttpApiSchema.status(404))],
  }),
  // Answer an `ask_user` call; without `answers` its questions are skipped.
  HttpApiEndpoint.post("answers", "/conversations/:id/answers", {
    params: ById,
    payload: Schema.Struct({
      key: Schema.String,
      answers: Schema.optionalKey(Schema.Array(QuestionAnswer)),
    }),
    success: HttpApiSchema.NoContent,
    error: [NotFound, ApprovalNotFound.pipe(HttpApiSchema.status(404))],
  }),
  // Thumbs up (`value: 1`) or down (`value: 0`) on an assistant entry, scored on its run's Langfuse trace.
  HttpApiEndpoint.post("feedback", "/conversations/:id/feedback", {
    params: ById,
    payload: Schema.Struct({
      entry: Schema.Int,
      value: Schema.Literals([0, 1]),
      comment: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty())),
    }),
    success: HttpApiSchema.NoContent,
    error: [NotFound, NoEntry, NoTrace],
  }),
  // Report an assistant entry; `comment` is required, scored on its run's Langfuse trace.
  HttpApiEndpoint.post("report", "/conversations/:id/report", {
    params: ById,
    payload: Schema.Struct({
      entry: Schema.Int,
      comment: Schema.Trim.check(Schema.isNonEmpty()),
    }),
    success: HttpApiSchema.NoContent,
    error: [NotFound, NoEntry, NoTrace],
  })
);

/** `conversation`: the attachment's conversation; left out for an upload staged for a conversation not created yet. */
const AttachmentScope = {
  conversation: Schema.optionalKey(Schema.FiniteFromString),
};

const AttachmentGroup = HttpApiGroup.make("attachments").add(
  // Upload one file: staged, or to `conversation`. It is checked and prepared before the answer.
  HttpApiEndpoint.post("upload", "/attachments", {
    payload: Schema.Struct({
      file: Multipart.SingleFileSchema,
      ...AttachmentScope,
    }).pipe(HttpApiSchema.asMultipart({ maxParts: 2 })),
    success: AttachmentInfo.pipe(HttpApiSchema.status(201)),
    error: [Refused, NotFound, Archived],
  }),
  // Remove an upload no message took yet.
  HttpApiEndpoint.delete("remove", "/attachments/:id", {
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent,
    error: NoAttachment,
  }),
  // The original, always as a download.
  HttpApiEndpoint.get("original", "/attachments/:id/original", {
    params: { id: Schema.String },
    query: AttachmentScope,
    success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    error: NoAttachment,
  }),
  // The attachment and what was prepared from it, for the console's viewer.
  HttpApiEndpoint.get("view", "/attachments/:id/view", {
    params: { id: Schema.String },
    query: AttachmentScope,
    success: Schema.Struct({
      info: AttachmentInfo,
      prepared: PreparedAttachment,
    }),
    error: NoAttachment,
  })
);

/**
 * An attachment's images: a PDF page drawn as WebP and an image's thumbnail. Outside `Authentication`, because
 * artifact pages show them from a sandboxed iframe whose opaque origin makes every request cross-site, so the
 * browser never sends the session cookie. The attachment id is the capability instead: 128 random bits, shown only
 * to its owner, and it serves only with its own `conversation`. Originals and the viewer stay behind a session.
 */
const AttachmentImageGroup = HttpApiGroup.make("attachmentImages").add(
  // One page of a PDF drawn as a WebP image, so the console shows the page without opening the PDF itself.
  HttpApiEndpoint.get("page", "/attachments/:id/pages/:page", {
    params: { id: Schema.String, page: Schema.Int },
    query: AttachmentScope,
    success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    error: [NoAttachment, Refused],
  }),
  // An image's small WebP preview.
  HttpApiEndpoint.get("thumbnail", "/attachments/:id/thumbnail", {
    params: { id: Schema.String },
    query: AttachmentScope,
    success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    error: NoAttachment,
  })
);

/** One version of an artifact, without the page. */
export const ArtifactVersionInfo = Schema.Struct({
  version: Schema.Int,
  title: Schema.String,
  createdAt: Schema.Number,
});

/** A page the agent wrote for the person, with its versions (see docs/adr/0003-artifacts-fetch-nothing.md). */
export const ArtifactInfo = Schema.Struct({
  id: Schema.String,
  /** The conversation the artifact belongs to; clients need it to build view/render/source URLs. */
  conversation: Schema.Number,
  title: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  versions: Schema.Array(ArtifactVersionInfo),
});
export type ArtifactInfo = typeof ArtifactInfo.Type;

/** `conversation`: the artifact's conversation. Left out it finds nothing on the scoped reads; on `list` it narrows the collection to one conversation. */
const ArtifactScope = {
  conversation: Schema.optionalKey(Schema.FiniteFromString),
};

const ArtifactVersionQuery = {
  ...ArtifactScope,
  /** The version to serve; the latest by default. */
  v: Schema.optionalKey(Schema.FiniteFromString),
};

const NoArtifact = ArtifactNotFound.pipe(HttpApiSchema.status(404));
const NoWorkspaceFile = WorkspaceFileNotFound.pipe(HttpApiSchema.status(404));
/** The conversation has no Sandbox to read files through: Level none, paused, or archived. */
const NoSandbox = SandboxUnavailable.pipe(HttpApiSchema.status(409));

const ArtifactGroup = HttpApiGroup.make("artifacts").add(
  // A conversation's artifacts, or without `conversation` every conversation's, most recently updated first.
  HttpApiEndpoint.get("list", "/artifacts", {
    query: ArtifactScope,
    success: Schema.Array(ArtifactInfo),
  }),
  // One artifact: its title and every version.
  HttpApiEndpoint.get("view", "/artifacts/:id", {
    params: { id: Schema.String },
    query: ArtifactScope,
    success: ArtifactInfo,
    error: NoArtifact,
  }),
  // The page itself, with its sandboxing headers: the console shows it in a sandboxed iframe.
  HttpApiEndpoint.get("render", "/artifacts/:id/render", {
    params: { id: Schema.String },
    query: ArtifactVersionQuery,
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: "text/html" })
    ),
    error: NoArtifact,
  }),
  // One version's source, for the panel's code tab.
  HttpApiEndpoint.get("source", "/artifacts/:id/source", {
    params: { id: Schema.String },
    query: ArtifactVersionQuery,
    success: Schema.Struct({ version: Schema.Int, html: Schema.String }),
    error: NoArtifact,
  }),
  // Remove an artifact and its versions.
  HttpApiEndpoint.delete("remove", "/artifacts/:id", {
    params: { id: Schema.String },
    query: ArtifactScope,
    success: HttpApiSchema.NoContent,
    error: NoArtifact,
  })
);

/**
 * The JavaScript files artifact pages may load, an allowlist served from node_modules; no CDNs. Outside
 * `Authentication` for the same reason as `attachmentImages`: the page's sandboxed iframe sends no cookie. They are
 * public library code, with nothing of any User's in them.
 */
const ArtifactLibGroup = HttpApiGroup.make("artifactLibs").add(
  HttpApiEndpoint.get("lib", "/artifact-libs/:file", {
    params: { file: Schema.String },
    success: Schema.Uint8Array.pipe(
      HttpApiSchema.asUint8Array({ contentType: "text/javascript" })
    ),
    error: NoArtifact,
  })
);

const BadDomain = InvalidDomain.pipe(HttpApiSchema.status(400));

const BadSkill = InvalidSkill.pipe(HttpApiSchema.status(400));
const NoSkill = SkillNotFound.pipe(HttpApiSchema.status(404));

// The name rule is SKILL_NAME in src/skills/format.ts; this module must stay free of runtime imports for web/.
const SkillName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message:
      "must be lowercase letters, digits and single hyphens, not at either end",
  })
);

const SkillGroup = HttpApiGroup.make("skills").add(
  // Create or replace an org skill's folder: `files` is every file it will hold, text only. `files` must include
  // a SKILL.md whose frontmatter parses and names this skill.
  HttpApiEndpoint.put("save", "/skills/:name", {
    params: { name: SkillName },
    payload: Schema.Struct({
      files: Schema.Record(Schema.String, Schema.String),
    }),
    success: Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      /** Every file in the folder, `SKILL.md` first. */
      files: Schema.Array(Schema.String),
    }),
    error: [BadSkill],
  }),
  // A skill folder's contents for the console's editor: text files decoded, non-UTF-8 ones named in binaryFiles.
  HttpApiEndpoint.get("get", "/skills/:name", {
    params: { name: SkillName },
    success: Schema.Struct({
      name: Schema.String,
      origin: Schema.Literals(["builtin", "org", "overridden"]),
      files: Schema.Record(Schema.String, Schema.String),
      binaryFiles: Schema.Array(Schema.String),
    }),
    error: NoSkill,
  }),
  // Delete the org copy: gone, or reverted to the builtin it shadowed. Idempotent like trustedDomains.remove.
  HttpApiEndpoint.delete("remove", "/skills/:name", {
    params: { name: SkillName },
    success: HttpApiSchema.NoContent,
  })
);

// The domains an artifact page may load images from, edited under Settings → Trusted domains; the render endpoint's
// img-src lists them, and create/update refuse a page whose other references fetch anything.
const TrustedDomainGroup = HttpApiGroup.make("trustedDomains").add(
  HttpApiEndpoint.get("list", "/trusted-domains", {
    success: Schema.Array(Schema.String),
  }),
  HttpApiEndpoint.post("add", "/trusted-domains", {
    payload: Schema.Struct({ domain: Schema.String }),
    success: Schema.Struct({ domain: Schema.String }).pipe(
      HttpApiSchema.status(201)
    ),
    error: [BadDomain],
  }),
  // Idempotent: removing a domain that is not trusted is a no-op.
  HttpApiEndpoint.delete("remove", "/trusted-domains/:domain", {
    params: { domain: Schema.String },
    success: HttpApiSchema.NoContent,
  })
);

/** A file or directory in a Conversation's Workspace, as the console's Files tab lists it. */
export const WorkspaceFileEntry = Schema.Struct({
  name: Schema.String,
  /** The path from the Workspace's root: `a/b.md`; a root entry's is its `name`. */
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  size: Schema.Number,
  mtimeMs: Schema.Number,
});
export type WorkspaceFileEntry = typeof WorkspaceFileEntry.Type;

const FileGroup = HttpApiGroup.make("files").add(
  // One directory of the Workspace, directories first; `path` defaults to the root. 500 entries at most.
  HttpApiEndpoint.get("list", "/conversations/:id/files", {
    params: ById,
    query: { path: Schema.optionalKey(Schema.String) },
    success: Schema.Struct({
      entries: Schema.Array(WorkspaceFileEntry),
      /** True when the directory holds more than fits in one listing. */
      truncated: Schema.Boolean,
    }),
    error: [NotFound, NoWorkspaceFile, NoSandbox],
  }),
  // One file's text for the console's viewer, capped (truncated); `binary` flags non-text files.
  HttpApiEndpoint.get("content", "/conversations/:id/files/content", {
    params: ById,
    query: { path: Schema.String },
    success: Schema.Struct({
      path: Schema.String,
      size: Schema.Number,
      truncated: Schema.Boolean,
      binary: Schema.Boolean,
      text: Schema.optionalKey(Schema.String),
    }),
    error: [NotFound, NoWorkspaceFile, NoSandbox],
  }),
  // The whole Workspace as one path list for the console's file tree: breadth-first, directories with a
  // trailing "/", 4000 paths at most.
  HttpApiEndpoint.get("tree", "/conversations/:id/files/tree", {
    params: ById,
    success: Schema.Struct({
      paths: Schema.Array(Schema.String),
      /** True when the Workspace holds more than fits in one listing. */
      truncated: Schema.Boolean,
    }),
    error: [NotFound, NoWorkspaceFile, NoSandbox],
  })
);

/** One span of a search snippet; `match` flags the part that hit the query. */
export const SnippetSegment = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean,
});
export type SnippetSegment = typeof SnippetSegment.Type;

/** One match inside a Conversation: its role, a highlighted snippet, and when it was written. */
export const SearchMatch = Schema.Struct({
  /** The matched entry; absent when the Conversation's title matched. */
  entry: Schema.optionalKey(Schema.Number),
  role: Schema.Literals(["title", "user", "assistant"]),
  snippet: Schema.Array(SnippetSegment),
  createdAt: Schema.Number,
});
export type SearchMatch = typeof SearchMatch.Type;

/** A Conversation and its best matches, best first. */
export const SearchResult = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  archived: Schema.Boolean,
  createdAt: Schema.Number,
  matches: Schema.Array(SearchMatch),
});
export type SearchResult = typeof SearchResult.Type;

const SearchGroup = HttpApiGroup.make("search").add(
  // Full-text over Conversation titles, prompts and assistant answers, grouped by Conversation, best
  // first; archived Conversations are included, flagged. An empty q lists the most recent.
  HttpApiEndpoint.get("query", "/search", {
    query: { q: Schema.String.check(Schema.isMaxLength(500)) },
    success: Schema.Array(SearchResult),
  })
);

const InfoGroup = HttpApiGroup.make("info").add(
  HttpApiEndpoint.get("get", "/info", {
    success: Schema.Struct({
      model: Schema.String,
      /** The server's own URL, for things the console cannot reach through its rewrite, like the shell socket. */
      apiUrl: Schema.String,
      /** Whether the server traces to Langfuse — only then can messages be scored. */
      tracing: Schema.Boolean,
      /** Generated titles are on: a real model is configured. */
      titleGeneration: Schema.Boolean,
    }),
  }),
  HttpApiEndpoint.get("capabilities", "/capabilities", {
    success: Capabilities,
  }),
  // Each Capacity resource's limit and holders, for choosing a Conversation to pause.
  HttpApiEndpoint.get("capacity", "/capacity", {
    success: Schema.Array(CapacityUsage),
  })
);

/** The signed-in User of the request, provided by `Authentication` to every endpoint outside `auth`. */
export class CurrentUser extends Context.Service<CurrentUser, User>()(
  "effect-pi/CurrentUser"
) {}

/**
 * Every endpoint outside the `auth` group needs a session cookie (401 `Unauthorized` without one), and any request
 * naming a Conversation — `/conversations/:id/...` or a `conversation` query — must name one of the User's own;
 * any other reads as `ConversationNotFound`, so ids of other people's Conversations are indistinguishable from
 * missing ones.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("effect-pi/Authentication", {
  security: {
    session: HttpApiSecurity.apiKey({ key: SESSION_COOKIE, in: "cookie" }),
  },
  error: [Unauthorized.pipe(HttpApiSchema.status(401)), NotFound],
}) {}

const Credentials = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(64)),
  password: Schema.String.check(Schema.isMaxLength(1024)),
});

// Signing in and out. Outside `Authentication`: these are how a request gets a session.
const AuthGroup = HttpApiGroup.make("auth").add(
  // Who the session cookie signs in, if anyone, and whether first-run setup is open (no account exists).
  HttpApiEndpoint.get("state", "/auth/state", {
    success: Schema.Struct({
      user: Schema.optionalKey(User),
      setup: Schema.Boolean,
    }),
  }),
  // Sets the session cookie.
  HttpApiEndpoint.post("login", "/auth/login", {
    payload: Credentials,
    success: User,
    error: [
      InvalidCredentials.pipe(HttpApiSchema.status(401)),
      TooManyAttempts.pipe(HttpApiSchema.status(429)),
    ],
  }),
  // Creates the first account, which adopts every Conversation and Trusted domain that predates accounts, and
  // signs it in. Closed once any account exists; later accounts come from `pnpm user add`.
  HttpApiEndpoint.post("setup", "/auth/setup", {
    payload: Credentials,
    success: User.pipe(HttpApiSchema.status(201)),
    error: [
      SetupClosed.pipe(HttpApiSchema.status(409)),
      InvalidAccount.pipe(HttpApiSchema.status(400)),
    ],
  }),
  // Ends the session and clears the cookie; without one it is a no-op.
  HttpApiEndpoint.post("logout", "/auth/logout", {
    success: HttpApiSchema.NoContent,
  })
);

export const Api = HttpApi.make("effect-pi")
  .add(ConversationGroup)
  .add(AttachmentGroup)
  .add(ArtifactGroup)
  .add(TrustedDomainGroup)
  .add(SkillGroup)
  .add(FileGroup)
  .add(SearchGroup)
  .add(InfoGroup)
  // Only the groups above: `auth`, `attachmentImages` and `artifactLibs` are added after, so they are reachable
  // without a session.
  .middleware(Authentication)
  .add(AuthGroup)
  .add(AttachmentImageGroup)
  .add(ArtifactLibGroup)
  .prefix("/api");
