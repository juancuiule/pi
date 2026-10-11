// ANSI escape sequences from tool output: pi's OutputBuffer.sanitize() deletes ESC wholesale, so a
// wrapper must strip them itself (keeping the raw copy for the console terminal). The model and the
// transcript see the stripped text.

const ESC = "\u001B";
const CSI8 = "\u009B";

const is = (c: string, lo: number, hi: number) => {
  const code = c.codePointAt(0) ?? 0;
  return code >= lo && code <= hi;
};
// CSI parameter bytes 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E.
const isParam = (c: string) => is(c, 0x30, 0x3f);
const isIntermediate = (c: string) => is(c, 0x20, 0x2f);
const isFinal = (c: string) => is(c, 0x40, 0x7e);

// OSC runs until BEL or ST (ESC \). A new ESC also ends it; the caller re-scans that ESC.
const oscEnd = (s: string, start: number): number => {
  let i = start;
  while (i < s.length) {
    if (s[i] === "\u0007") {
      return i + 1;
    }
    if (s[i] === ESC) {
      return s[i + 1] === "\\" ? i + 2 : i;
    }
    i += 1;
  }
  return s.length;
};

// CSI body after ESC [ or the 8-bit CSI: params, intermediates, then one final byte.
const csiEnd = (s: string, start: number): number => {
  let i = start;
  while (i < s.length && (isParam(s[i]) || isIntermediate(s[i]))) {
    i += 1;
  }
  if (i >= s.length) {
    return s.length;
  }
  // A final byte ends it; anything else is malformed, so drop what was scanned and re-scan the rest.
  return isFinal(s[i]) ? i + 1 : i;
};

// Length of the escape sequence starting at `s[start]`, or `s.length` when incomplete.
const sequenceEnd = (s: string, start: number): number => {
  let i = start;
  if (s[i] === CSI8) {
    return csiEnd(s, i + 1);
  }
  if (s[i] !== ESC) {
    return i + 1;
  }
  i += 1;
  const next = s[i];
  if (next === undefined) {
    return s.length;
  }
  if (next === "[") {
    return csiEnd(s, i + 1);
  }
  if (next === "]") {
    return oscEnd(s, i + 1);
  }
  if (next === "(" || next === ")" || next === "*" || next === "+") {
    // Charset designator: ESC <opener> <one byte>.
    return i + 2 <= s.length ? i + 2 : s.length;
  }
  if (is(next, 0x40, 0x7f)) {
    // Two-byte escape (Fe) or anything unknown after ESC: drop ESC and the byte.
    return i + 1;
  }
  // ESC before control or high-byte text: drop just the ESC.
  return i;
};

/**
 * A streaming ANSI stripper. A sequence split across `push` calls is held back until the next chunk
 * completes it; `end()` drops an unterminated trailing sequence. Plain text — including `\n`, `\t`,
 * and `\r` — passes through.
 */
export const createAnsiStripper = (): {
  push: (chunk: string) => string;
  end: () => string;
} => {
  let pending = "";
  const push = (chunk: string): string => {
    const s = pending + chunk;
    pending = "";
    let out = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ESC || c === CSI8) {
        const end = sequenceEnd(s, i);
        if (end === s.length) {
          pending = s.slice(i);
          break;
        }
        i = end;
      } else {
        out += c;
        i += 1;
      }
    }
    return out;
  };
  // An unterminated sequence has no safe text interpretation; it is dropped, not emitted.
  return { push, end: () => "" };
};
