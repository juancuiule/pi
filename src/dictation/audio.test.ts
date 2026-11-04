import { describe, expect, it } from "vitest";

import { silence, speech } from "../testing/dictation.ts";
import { pcmOf, Segmenter, wavOf } from "./audio.ts";

const RATE = 16_000;
const ms = (samples: number) => Math.round((samples / RATE) * 1000);

describe(pcmOf, () => {
  it("reads little-endian PCM16 and drops an odd trailing byte", () => {
    const bytes = new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x42]);
    expect([...pcmOf(bytes)]).toStrictEqual([1, 32_767, -32_768]);
  });
});

describe(wavOf, () => {
  it("writes a mono 16-bit WAV header before the samples", () => {
    const wav = wavOf(new Int16Array([1, -1]), RATE);
    const view = new DataView(wav.buffer);
    const text = (from: number, to: number) =>
      String.fromCodePoint(...wav.slice(from, to));
    expect({
      riff: text(0, 4),
      wave: text(8, 12),
      channels: view.getUint16(22, true),
      rate: view.getUint32(24, true),
      dataBytes: view.getUint32(40, true),
      samples: [view.getInt16(44, true), view.getInt16(46, true)],
    }).toStrictEqual({
      riff: "RIFF",
      wave: "WAVE",
      channels: 1,
      rate: RATE,
      dataBytes: 4,
      samples: [1, -1],
    });
  });
});

describe(Segmenter, () => {
  it("closes a segment at a pause, keeping a little audio around the speech", () => {
    const segmenter = new Segmenter({ sampleRate: RATE, pauseMs: 500 });
    expect(segmenter.feed(silence(500))).toStrictEqual([]);
    expect(segmenter.feed(speech(1000))).toStrictEqual([]);
    expect(segmenter.open()?.id).toBe(0);
    const closed = segmenter.feed(silence(800));
    const [segment] = closed;
    const length = ms(segment?.audio.length ?? 0);
    // 1 s of speech, up to 300 ms of pre-roll before it and 300 ms of tail after.
    expect({
      closed: closed.length,
      long: length >= 1000 && length <= 1700,
      speech: (segment?.speechMs ?? 0) >= 900,
      open: segmenter.open(),
    }).toStrictEqual({ closed: 1, long: true, speech: true, open: undefined });
  });

  it("numbers segments in order and never makes one of silence", () => {
    const segmenter = new Segmenter({ sampleRate: RATE, pauseMs: 400 });
    const closed = [
      ...segmenter.feed(speech(600)),
      ...segmenter.feed(silence(600)),
      ...segmenter.feed(silence(3000)),
      ...segmenter.feed(speech(600)),
      ...segmenter.feed(silence(600)),
    ];
    expect(closed.map((segment) => segment.id)).toStrictEqual([0, 1]);
    expect(segmenter.flush()).toBeUndefined();
  });

  it("ignores a click shorter than the onset", () => {
    const segmenter = new Segmenter({ sampleRate: RATE });
    segmenter.feed(silence(300));
    segmenter.feed(speech(20));
    segmenter.feed(silence(1000));
    expect(segmenter.open()).toBeUndefined();
    expect(segmenter.flush()).toBeUndefined();
  });

  it("cuts a segment at the length cap without a pause", () => {
    const segmenter = new Segmenter({ sampleRate: RATE, maxSegmentMs: 2000 });
    const closed = segmenter.feed(speech(5000));
    expect(closed).toHaveLength(2);
    expect(ms(closed[0]?.audio.length ?? 0)).toBe(2000);
    expect(segmenter.open()?.id).toBe(2);
  });

  it("flushes the open segment, frames split across pushes included", () => {
    const segmenter = new Segmenter({ sampleRate: RATE });
    const audio = speech(1000);
    for (let at = 0; at < audio.length; at += 333) {
      segmenter.feed(audio.subarray(at, at + 333));
    }
    const segment = segmenter.flush();
    expect(segment?.id).toBe(0);
    expect(segment?.audio.length).toBe(audio.length);
  });
});
