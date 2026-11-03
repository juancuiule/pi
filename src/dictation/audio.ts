// Pure audio helpers for dictation: PCM16 from the socket's bytes, a WAV file for the transcription request, and the
// segmenter that cuts a dictation into segments at pauses.

/** The samples in a binary frame of little-endian PCM16; an odd trailing byte is dropped. */
export const pcmOf = (bytes: Uint8Array): Int16Array => {
  const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
};

/** A mono PCM16 WAV file of `samples`: what every `/audio/transcriptions` server accepts, with no encoder. */
export const wavOf = (
  samples: Int16Array,
  sampleRate: number
): Uint8Array<ArrayBuffer> => {
  const header = 44;
  const bytes = new Uint8Array(header + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.codePointAt(index) ?? 0);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(header + index * 2, samples[index] ?? 0, true);
  }
  return bytes;
};

const concat = (chunks: readonly Int16Array[]): Int16Array => {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const joined = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

/** How the segmenter hears speech and pauses; durations in milliseconds. */
export interface SegmenterOptions {
  readonly sampleRate: number;
  /** Silence after speech that closes a segment. */
  readonly pauseMs?: number | undefined;
  /** A segment this long closes even without a pause, so no request grows past it. */
  readonly maxSegmentMs?: number | undefined;
  /** Audio kept from before speech starts, so the first syllable is not cut. */
  readonly preRollMs?: number | undefined;
  /** Silence kept after the last speech in a closed segment. */
  readonly tailMs?: number | undefined;
  /** Frame RMS (0..1) below which a frame is never speech, however quiet the room. */
  readonly minSpeechRms?: number | undefined;
}

/** A segment that holds speech. */
export interface Segment {
  readonly id: number;
  readonly audio: Int16Array;
  /** Milliseconds of frames heard as speech. */
  readonly speechMs: number;
}

const FRAME_MS = 20;
/** Consecutive speech frames that open a segment: a click or a breath does not. */
const ONSET_FRAMES = 3;

/**
 * Cuts a stream of PCM into segments at pauses, by frame energy against an adaptive noise floor. Only audio with
 * speech becomes a segment: Whisper invents text for silence ("Gracias por ver el video"), so silence is never sent.
 * `feed` returns the segments a pause (or the length cap) closed; `open` is the segment still being spoken;
 * `flush` closes it.
 */
export class Segmenter {
  readonly #frame: number;
  readonly #pauseFrames: number;
  readonly #maxFrames: number;
  readonly #preRollFrames: number;
  readonly #tailFrames: number;
  readonly #minRms: number;
  #leftover = new Int16Array(0);
  /** Frames before speech, at most the pre-roll. */
  #before: Int16Array[] = [];
  /** The open segment's frames, from its pre-roll on. */
  #frames: Int16Array[] = [];
  #speechFrames = 0;
  #silentRun = 0;
  #onsetRun = 0;
  #floor = 0;
  #nextId = 0;
  #openId: number | undefined;

  constructor(options: SegmenterOptions) {
    this.#frame = Math.round((options.sampleRate * FRAME_MS) / 1000);
    this.#pauseFrames = Math.ceil((options.pauseMs ?? 700) / FRAME_MS);
    this.#maxFrames = Math.ceil((options.maxSegmentMs ?? 20_000) / FRAME_MS);
    this.#preRollFrames = Math.ceil((options.preRollMs ?? 300) / FRAME_MS);
    this.#tailFrames = Math.ceil((options.tailMs ?? 300) / FRAME_MS);
    this.#minRms = options.minSpeechRms ?? 0.01;
  }

  /** Feeds samples; returns the segments that closed. */
  feed(samples: Int16Array): Segment[] {
    const all = concat([this.#leftover, samples]);
    const closed: Segment[] = [];
    let offset = 0;
    for (; offset + this.#frame <= all.length; offset += this.#frame) {
      const segment = this.#frameIn(all.slice(offset, offset + this.#frame));
      if (segment !== undefined) {
        closed.push(segment);
      }
    }
    this.#leftover = all.slice(offset);
    return closed;
  }

  /** The segment being spoken, if speech has started and not paused yet. */
  open(): Segment | undefined {
    return this.#openId === undefined
      ? undefined
      : {
          id: this.#openId,
          audio: concat(this.#frames),
          speechMs: this.#speechFrames * FRAME_MS,
        };
  }

  /** Closes the open segment (the dictation stopped); returns it if it had speech. */
  flush(): Segment | undefined {
    if (this.#leftover.length > 0) {
      this.#frames.push(this.#leftover);
      this.#leftover = new Int16Array(0);
    }
    return this.#close(0);
  }

  #frameIn(frame: Int16Array): Segment | undefined {
    let sum = 0;
    for (const sample of frame) {
      sum += (sample / 32_768) ** 2;
    }
    const rms = Math.sqrt(sum / frame.length);
    // The noise floor starts at zero (someone may speak from the first frame) and follows quiet frames quickly and
    // loud ones slowly, so a noisy room raises the threshold within a second and speech barely does.
    const speech = rms > Math.max(this.#minRms, this.#floor * 3);
    this.#floor += (rms - this.#floor) * (speech ? 0.0005 : 0.05);

    if (this.#openId === undefined) {
      this.#before.push(frame);
      if (this.#before.length > this.#preRollFrames + ONSET_FRAMES) {
        this.#before.shift();
      }
      this.#onsetRun = speech ? this.#onsetRun + 1 : 0;
      if (this.#onsetRun >= ONSET_FRAMES) {
        this.#openId = this.#nextId;
        this.#nextId += 1;
        this.#frames = this.#before;
        this.#before = [];
        this.#speechFrames = ONSET_FRAMES;
        this.#silentRun = 0;
      }
      return;
    }

    this.#frames.push(frame);
    if (speech) {
      this.#speechFrames += 1;
      this.#silentRun = 0;
    } else {
      this.#silentRun += 1;
    }
    if (this.#silentRun >= this.#pauseFrames) {
      return this.#close(Math.max(0, this.#silentRun - this.#tailFrames));
    }
    if (this.#frames.length >= this.#maxFrames) {
      return this.#close(0);
    }
  }

  /** Ends the open segment, dropping `trim` trailing frames of silence. */
  #close(trim: number): Segment | undefined {
    const id = this.#openId;
    if (id === undefined) {
      return;
    }
    const frames = this.#frames.slice(0, this.#frames.length - trim);
    const segment = {
      id,
      audio: concat(frames),
      speechMs: this.#speechFrames * FRAME_MS,
    };
    this.#openId = undefined;
    this.#frames = [];
    this.#before = [];
    this.#speechFrames = 0;
    this.#silentRun = 0;
    this.#onsetRun = 0;
    return segment;
  }
}
