// Pure helpers for dictation in the composer (use-dictation.ts runs the microphone and the socket): resampling the
// microphone to the socket's 16 kHz PCM16, the level meter, reading the server's messages, and placing final text in
// the prompt at the caret where dictation started. Protocol: src/dictation/protocol.ts; decisions: docs/adr/0013.
import { Option, Schema } from "effect";
import { DICTATION_SAMPLE_RATE, DictationServerMessage } from "effect-pi/api";
import type { DictationLanguage } from "effect-pi/api";

/** The language toggle's choices, in the order a click cycles through them; `null` lets the backend detect it. */
export const LANGUAGE_CHOICES: readonly (DictationLanguage | null)[] = [
  "es",
  "en",
  null,
];

export const languageLabel = (language: DictationLanguage | null) =>
  language === null ? "Auto" : language.toUpperCase();

export const languageName = (language: DictationLanguage | null) => {
  if (language === "es") {
    return "Spanish";
  }
  return language === "en" ? "English" : "detected automatically";
};

/** The choice after `language` on the toggle. */
export const nextLanguage = (
  language: DictationLanguage | null
): DictationLanguage | null => {
  const next =
    LANGUAGE_CHOICES[
      (LANGUAGE_CHOICES.indexOf(language) + 1) % LANGUAGE_CHOICES.length
    ];
  return next === undefined ? "es" : next;
};

/** A stored choice back from localStorage: `es`, `en` or `auto`; anything else is the default, Spanish. */
export const parseLanguage = (
  stored: string | null
): DictationLanguage | null => {
  if (stored === "auto") {
    return null;
  }
  return stored === "en" ? "en" : "es";
};

export const storedLanguage = (language: DictationLanguage | null) =>
  language ?? "auto";

/**
 * A resampler from the microphone's rate (usually 48 kHz, which iOS imposes) to 16 kHz PCM16. Each output sample
 * averages the input samples it covers, a box filter that keeps most aliasing out of speech; the fractional position
 * carries across calls, so chunk boundaries do not click.
 */
export const createResampler = (fromRate: number) => {
  const step = fromRate / DICTATION_SAMPLE_RATE;
  let position = 0;
  let carry = new Float32Array(0);
  return (input: Float32Array): Int16Array => {
    let samples = input;
    if (carry.length > 0) {
      samples = new Float32Array(carry.length + input.length);
      samples.set(carry);
      samples.set(input, carry.length);
    }
    const output: number[] = [];
    while (position + step <= samples.length) {
      const start = Math.floor(position);
      const end = Math.max(start + 1, Math.floor(position + step));
      let sum = 0;
      for (let index = start; index < end; index += 1) {
        sum += samples[index] ?? 0;
      }
      const value = Math.max(-1, Math.min(1, sum / (end - start)));
      output.push(Math.round(value < 0 ? value * 32_768 : value * 32_767));
      position += step;
    }
    const consumed = Math.floor(position);
    carry = samples.slice(consumed);
    position -= consumed;
    return Int16Array.from(output);
  };
};

/** The meter's level for a chunk, 0..1: RMS on a curve that makes speech fill most of it. */
export const levelOf = (input: Float32Array): number => {
  if (input.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of input) {
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(Math.sqrt(sum / input.length)) * 1.6);
};

/** Little-endian bytes of PCM16 samples: the socket's binary frame. */
export const pcmFrame = (samples: Int16Array): ArrayBuffer => {
  const bytes = new ArrayBuffer(samples.length * 2);
  const view = new DataView(bytes);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
};

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(DictationServerMessage)
);

/** A server text frame, or `undefined` for anything this console does not know. */
export const parseDictationMessage = (
  raw: string
): DictationServerMessage | undefined =>
  Option.getOrUndefined(decodeMessage(raw));

const NO_SPACE_BEFORE = /^[\s.,;:!?)\]}»”'’…]/u;
const NO_SPACE_AFTER = /[\s([{«“¿¡]$/u;

/**
 * `text` put into `value` at `anchor`, with a space on either side where words would otherwise touch; returns the
 * new value and the anchor after the inserted text, where the next final goes.
 */
export const insertDictated = (
  value: string,
  anchor: number,
  text: string
): { readonly value: string; readonly anchor: number } => {
  const at = Math.max(0, Math.min(anchor, value.length));
  const words = text.trim();
  if (words === "") {
    return { value, anchor: at };
  }
  const before = value.slice(0, at);
  const after = value.slice(at);
  const lead =
    before === "" || NO_SPACE_AFTER.test(before) || NO_SPACE_BEFORE.test(words)
      ? ""
      : " ";
  const trail = after === "" || NO_SPACE_BEFORE.test(after) ? "" : " ";
  const inserted = `${lead}${words}`;
  return {
    value: `${before}${inserted}${trail}${after}`,
    anchor: before.length + inserted.length,
  };
};

/**
 * Where the anchor is after the person edited the prompt from `previous` to `next` while dictating: an edit before it
 * moves it by the change in length, an edit after it leaves it.
 */
export const shiftAnchor = (
  previous: string,
  next: string,
  anchor: number
): number => {
  let prefix = 0;
  const shortest = Math.min(previous.length, next.length);
  while (prefix < shortest && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  if (prefix >= anchor) {
    return Math.min(anchor, next.length);
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  // The edit spans [prefix, previous.length - suffix); an anchor inside it lands at the edit's end.
  if (previous.length - suffix > anchor) {
    return next.length - suffix;
  }
  return Math.max(0, anchor + next.length - previous.length);
};

/** The interim text of the segments still open, in order: what the live strip shows. */
export const interimOf = (segments: ReadonlyMap<number, string>): string =>
  [...segments.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, text]) => text.trim())
    .filter((text) => text !== "")
    .join(" ");

/** `m:ss` for the timer. */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Whether a keydown toggles dictation: ⌘⇧Space or Ctrl+Shift+Space, held-down repeats excluded. */
export const isDictationShortcut = (event: {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey?: boolean;
  readonly repeat?: boolean;
}): boolean =>
  (event.metaKey || event.ctrlKey) &&
  event.shiftKey &&
  event.altKey !== true &&
  (event.code === "Space" || event.key === " ") &&
  event.repeat !== true;

/** Why the microphone cannot be used here, or `ok`. */
export type DictationAvailability = "ok" | "insecure" | "unsupported";

export const availabilityOf = (page: {
  readonly isSecureContext: boolean;
  readonly hasMediaDevices: boolean;
  readonly hasAudioWorklet: boolean;
}): DictationAvailability => {
  if (!page.isSecureContext) {
    return "insecure";
  }
  return page.hasMediaDevices && page.hasAudioWorklet ? "ok" : "unsupported";
};

/** What the person reads when dictation cannot start or stops early; the text dictated so far always stays. */
export const DICTATION_PROBLEMS = {
  insecure:
    "Dictation needs a secure connection. Open the console through its https address (Tailscale or Cloudflare) or on localhost.",
  unsupported: "This browser cannot record audio for dictation.",
  denied:
    "The microphone is blocked. Allow it in this site's settings, then try again.",
  "no-device": "No microphone was found.",
  "no-sound":
    "No sound from the microphone. Check that the right one is selected and not muted.",
  unavailable:
    "Transcription is unavailable right now. What you dictated so far is kept.",
  connection: "The connection dropped. What you dictated so far is kept.",
  protocol: "Dictation failed to start. Try again.",
} as const;
export type DictationProblem = keyof typeof DICTATION_PROBLEMS;

/** The problem a `getUserMedia` failure means. */
export const problemOfMediaError = (error: unknown): DictationProblem => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "denied";
  }
  return name === "NotFoundError" || name === "OverconstrainedError"
    ? "no-device"
    : "unsupported";
};
