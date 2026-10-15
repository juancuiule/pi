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

/** An Upgrade must raise the Level: none, then shell, then desktop. */
export class InvalidUpgrade extends Schema.TaggedError<InvalidUpgrade>()(
  "InvalidUpgrade",
  {
    id: Schema.Number,
    from: Schema.Literals(["none", "shell", "desktop"]),
    to: Schema.Literals(["none", "shell", "desktop"]),
  }
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
