// Errors the server reports to clients. Kept free of runtime dependencies so web/ can import them through the API
// definition.
import { Schema } from "effect";

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { id: Schema.Number }
) {}

export class SandboxLimitReached extends Schema.TaggedError<SandboxLimitReached>()(
  "SandboxLimitReached",
  { limit: Schema.Number }
) {}

export class ConversationEnded extends Schema.TaggedError<ConversationEnded>()(
  "ConversationEnded",
  { id: Schema.Number, reason: Schema.Literals(["ended", "sandbox_removed"]) }
) {}

export class ApprovalNotFound extends Schema.TaggedError<ApprovalNotFound>()(
  "ApprovalNotFound",
  { key: Schema.String }
) {}
