import { describe, expect, it } from "vitest";

import {
  availabilityOf,
  createResampler,
  formatElapsed,
  insertDictated,
  interimOf,
  isDictationShortcut,
  levelOf,
  nextLanguage,
  parseDictationMessage,
  parseLanguage,
  pcmFrame,
  problemOfMediaError,
  shiftAnchor,
} from "./dictation";

describe(insertDictated, () => {
  it("inserts at the anchor with spaces where words would touch", () => {
    expect(insertDictated("Revisá  por favor", 7, "el deploy")).toStrictEqual({
      value: "Revisá el deploy por favor",
      anchor: 16,
    });
  });

  it("adds no space before punctuation or after an opening mark", () => {
    expect(insertDictated("Hola", 4, ", ¿cómo va?").value).toBe(
      "Hola, ¿cómo va?"
    );
    expect(insertDictated("¿", 1, "Qué tal").value).toBe("¿Qué tal");
  });

  it("chains finals: each goes after the previous one", () => {
    const first = insertDictated("", 0, "Primero.");
    const second = insertDictated(first.value, first.anchor, "Segundo.");
    expect(second).toStrictEqual({
      value: "Primero. Segundo.",
      anchor: 17,
    });
  });

  it("leaves the prompt alone for empty text, and clamps the anchor", () => {
    expect(insertDictated("abc", 9, "  ")).toStrictEqual({
      value: "abc",
      anchor: 3,
    });
  });
});

describe(shiftAnchor, () => {
  it("keeps the anchor for an edit after it", () => {
    expect(shiftAnchor("hello world", "hello world!", 5)).toBe(5);
  });

  it("moves it by an edit before it", () => {
    expect(shiftAnchor("hello world", "Oh, hello world", 5)).toBe(9);
    expect(shiftAnchor("hello world", "ello world", 5)).toBe(4);
  });

  it("puts it at the end of an edit that spans it", () => {
    expect(shiftAnchor("hello world", "helrld", 5)).toBe(3);
  });
});

describe(createResampler, () => {
  it("turns 48 kHz into a third as many 16 kHz samples across chunks", () => {
    const resample = createResampler(48_000);
    const chunk = new Float32Array(128).fill(0.5);
    let total = 0;
    for (let index = 0; index < 30; index += 1) {
      total += resample(chunk).length;
    }
    expect(total).toBe(1280);
  });

  it("converts to PCM16 and clips out-of-range samples", () => {
    const resample = createResampler(16_000);
    expect([...resample(Float32Array.from([0, 0.5, -1, 2]))]).toStrictEqual([
      0, 16_384, -32_768, 32_767,
    ]);
  });

  it("handles a rate that does not divide evenly", () => {
    const resample = createResampler(44_100);
    const out = resample(new Float32Array(44_100).fill(0.25));
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
  });
});

describe(pcmFrame, () => {
  it("writes little-endian PCM16", () => {
    expect([
      ...new Uint8Array(pcmFrame(Int16Array.from([1, -2]))),
    ]).toStrictEqual([1, 0, 254, 255]);
  });
});

describe(levelOf, () => {
  it("is 0 for silence and grows with loudness, capped at 1", () => {
    const quiet = levelOf(new Float32Array(256).fill(0.01));
    const loud = levelOf(new Float32Array(256).fill(0.5));
    expect({
      silence: levelOf(new Float32Array(256)),
      ordered: quiet < loud,
      capped: levelOf(new Float32Array(256).fill(1)),
    }).toStrictEqual({ silence: 0, ordered: true, capped: 1 });
  });
});

describe(parseDictationMessage, () => {
  it("reads the server's messages and refuses anything else", () => {
    expect(
      parseDictationMessage('{"type":"final","segment":2,"text":"hola"}')
    ).toStrictEqual({ type: "final", segment: 2, text: "hola" });
    expect(parseDictationMessage('{"type":"nope"}')).toBeUndefined();
    expect(parseDictationMessage("not json")).toBeUndefined();
  });
});

describe(interimOf, () => {
  it("joins the open segments' text in segment order", () => {
    expect(
      interimOf(
        new Map([
          [3, "y después"],
          [2, "vamos "],
          [4, ""],
        ])
      )
    ).toBe("vamos y después");
  });
});

const event = (init: Partial<Parameters<typeof isDictationShortcut>[0]>) => ({
  key: " ",
  code: "Space",
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  ...init,
});

describe(isDictationShortcut, () => {
  it("is ⌘⇧Space or Ctrl+Shift+Space, not repeats or plain Space", () => {
    expect({
      mac: isDictationShortcut(event({ metaKey: true })),
      pc: isDictationShortcut(event({ ctrlKey: true })),
      repeat: isDictationShortcut(event({ metaKey: true, repeat: true })),
      noShift: isDictationShortcut(event({ metaKey: true, shiftKey: false })),
      plain: isDictationShortcut(event({})),
    }).toStrictEqual({
      mac: true,
      pc: true,
      repeat: false,
      noShift: false,
      plain: false,
    });
  });
});

describe(availabilityOf, () => {
  it("needs a secure context first, then the audio APIs", () => {
    expect(
      availabilityOf({
        isSecureContext: false,
        hasMediaDevices: false,
        hasAudioWorklet: true,
      })
    ).toBe("insecure");
    expect(
      availabilityOf({
        isSecureContext: true,
        hasMediaDevices: true,
        hasAudioWorklet: false,
      })
    ).toBe("unsupported");
    expect(
      availabilityOf({
        isSecureContext: true,
        hasMediaDevices: true,
        hasAudioWorklet: true,
      })
    ).toBe("ok");
  });
});

describe(problemOfMediaError, () => {
  it("tells a blocked microphone from a missing one", () => {
    expect(problemOfMediaError(new DOMException("no", "NotAllowedError"))).toBe(
      "denied"
    );
    expect(problemOfMediaError(new DOMException("no", "NotFoundError"))).toBe(
      "no-device"
    );
    expect(problemOfMediaError(new Error("other"))).toBe("unsupported");
  });
});

describe("the language toggle", () => {
  it("cycles ES, EN, Auto and defaults to Spanish", () => {
    expect({
      cycle: [nextLanguage("es"), nextLanguage("en"), nextLanguage(null)],
      stored: [parseLanguage("en"), parseLanguage("auto"), parseLanguage(null)],
    }).toStrictEqual({ cycle: ["en", null, "es"], stored: ["en", null, "es"] });
  });
});

describe(formatElapsed, () => {
  it("formats minutes and seconds", () => {
    expect([
      formatElapsed(0),
      formatElapsed(12_500),
      formatElapsed(65_000),
    ]).toStrictEqual(["0:00", "0:12", "1:05"]);
  });
});
