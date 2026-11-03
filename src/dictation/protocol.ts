// oxlint-disable no-redeclare -- a schema and its type share a name, the Effect idiom
// The dictation socket's messages (`GET /api/dictation`), shared with web/ through `effect-pi/api`; pure, no pi
// imports. The client opens with a `start` text frame, then sends binary frames of 16 kHz mono PCM16 (little endian)
// and ends with `stop` (flush what was said, then `done`) or `cancel` (drop everything; closing the socket does the
// same). The server cuts the audio into segments at pauses: while a segment is open it sends `interim` text for it,
// replaced by one `final` when the segment closes. Finals arrive in segment order. Decisions: docs/adr/0010.
import { Schema } from "effect";

/** The rate of the PCM the client sends. */
export const DICTATION_SAMPLE_RATE = 16_000;

/** The languages a person can pin; `null` lets the backend detect it. */
export const DICTATION_LANGUAGES = ["es", "en"] as const;
export const DictationLanguage = Schema.Literals(DICTATION_LANGUAGES);
export type DictationLanguage = typeof DictationLanguage.Type;

export const DictationClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    language: Schema.NullOr(DictationLanguage),
  }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("cancel") }),
]);
export type DictationClientMessage = typeof DictationClientMessage.Type;

/** Why a dictation ended early; the text finalized before it stays. */
export const DICTATION_ERRORS = [
  // The transcription service failed or timed out twice in a row.
  "unavailable",
  // The first frame was not a `start`, or a frame could not be read.
  "protocol",
] as const;
export const DictationError = Schema.Literals(DICTATION_ERRORS);
export type DictationError = typeof DictationError.Type;

export const DictationServerMessage = Schema.Union([
  /** The session is listening; `maxSeconds` is the longest it accepts, `interim` whether live text is sent. */
  Schema.Struct({
    type: Schema.Literal("ready"),
    maxSeconds: Schema.Number,
    interim: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("interim"),
    segment: Schema.Number,
    text: Schema.String,
  }),
  /** The segment's text for good; it replaces the segment's interim text, and may be empty (only noise). */
  Schema.Struct({
    type: Schema.Literal("final"),
    segment: Schema.Number,
    text: Schema.String,
  }),
  /** `maxSeconds` of audio arrived: the server stops listening, finishes the open segment, then sends `done`. */
  Schema.Struct({ type: Schema.Literal("limit") }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: DictationError,
    message: Schema.String,
  }),
  /** Every segment is final; the server closes the socket next. */
  Schema.Struct({ type: Schema.Literal("done") }),
]);
export type DictationServerMessage = typeof DictationServerMessage.Type;
