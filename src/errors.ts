// Errors the server reports to clients. Kept free of runtime dependencies so web/ can import them through the API
// definition.
import { Schema } from "effect";

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { id: Schema.Number }
) {}

/** A Capacity limit is reached; `holders` are the Conversations holding `resource`, for the person to pick one to Pause. */
export class CapacityExhausted extends Schema.TaggedError<CapacityExhausted>()(
  "CapacityExhausted",
  {
    resource: Schema.Literals(["seat", "shell", "desktop"]),
    limit: Schema.Number,
    holders: Schema.Array(Schema.Number),
  }
) {}

/** The Conversation is archived: it can be read, and unarchived, but gets no Seat. */
export class ConversationArchived extends Schema.TaggedError<ConversationArchived>()(
  "ConversationArchived",
  { id: Schema.Number }
) {}

export class ApprovalNotFound extends Schema.TaggedError<ApprovalNotFound>()(
  "ApprovalNotFound",
  { key: Schema.String }
) {}

export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()(
  "SkillNotFound",
  { name: Schema.String, available: Schema.Array(Schema.String) }
) {}

/** No such transcript entry in the conversation it was asked for — or it is not an assistant message. */
export class EntryNotFound extends Schema.TaggedError<EntryNotFound>()(
  "EntryNotFound",
  { id: Schema.Number, entry: Schema.Number }
) {}

/**
 * An entry's run has no trace to score: the server does not trace (`disabled`), or the entry's task left none
 * (`untraced` — an aborted partial, or a conversation whose run predates tracing).
 */
export class TraceUnavailable extends Schema.TaggedError<TraceUnavailable>()(
  "TraceUnavailable",
  {
    id: Schema.Number,
    entry: Schema.optionalKey(Schema.Number),
    reason: Schema.Literals(["disabled", "untraced"]),
  }
) {}

/**
 * An Upgrade must raise the Level (none, then shell, then desktop), add Software, or both. `reason` says why the
 * Level cannot have the Software asked for.
 */
export class InvalidUpgrade extends Schema.TaggedError<InvalidUpgrade>()(
  "InvalidUpgrade",
  {
    id: Schema.Number,
    from: Schema.Literals(["none", "shell", "desktop"]),
    to: Schema.Literals(["none", "shell", "desktop"]),
    reason: Schema.optionalKey(Schema.String),
  }
) {}

/** The Conversation has no Sandbox to run a shell in: Level none, or the Sandbox is being replaced. */
export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()(
  "SandboxUnavailable",
  { id: Schema.Number }
) {}

/** A settings change that cannot be applied: an unknown name, a locked extension, or one the Level does not allow. */
export class InvalidSetting extends Schema.TaggedError<InvalidSetting>()(
  "InvalidSetting",
  { name: Schema.String, reason: Schema.String }
) {}

/** No attachment with this id in the scope it was asked for: another conversation's, sent already, or expired. */
export class AttachmentNotFound extends Schema.TaggedError<AttachmentNotFound>()(
  "AttachmentNotFound",
  { id: Schema.String }
) {}

/**
 * An upload or message that cannot take a file: not a format we read (`unsupported`), over a limit (`too_large`), or
 * a file that could not be read (`failed`). Nothing is kept.
 */
export class AttachmentRefused extends Schema.TaggedError<AttachmentRefused>()(
  "AttachmentRefused",
  {
    reason: Schema.Literals(["unsupported", "too_large", "failed"]),
    message: Schema.String,
  }
) {}

/** A message needs text, attachments, or both. */
export class EmptyMessage extends Schema.TaggedError<EmptyMessage>()(
  "EmptyMessage",
  {}
) {}

/** No artifact with this id in the conversation it was asked for. */
export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()(
  "ArtifactNotFound",
  { id: Schema.String }
) {}

/** No readable file or directory at this path in the Conversation's Workspace, or the path escapes it. */
export class WorkspaceFileNotFound extends Schema.TaggedError<WorkspaceFileNotFound>()(
  "WorkspaceFileNotFound",
  { path: Schema.String }
) {}

/**
 * A page or change `artifact_create`/`artifact_update` cannot take: over the size cap, more edits than allowed, or
 * a `find` that is missing or not unique. `reason` is the sentence the model reads.
 */
export class ArtifactRefused extends Schema.TaggedError<ArtifactRefused>()(
  "ArtifactRefused",
  { reason: Schema.String }
) {}

/** A trusted-domains entry that is not a hostname: `domain` is what was entered, `reason` what is wrong with it. */
export class InvalidDomain extends Schema.TaggedError<InvalidDomain>()(
  "InvalidDomain",
  { domain: Schema.String, reason: Schema.String }
) {}

/**
 * A skill folder whose SKILL.md does not parse or a skill upload that cannot be taken: a bad name or file path,
 * no SKILL.md, or invalid frontmatter. `message` is the sentence the caller reads.
 */
export class InvalidSkill extends Schema.TaggedError<InvalidSkill>()(
  "InvalidSkill",
  { message: Schema.String }
) {}
