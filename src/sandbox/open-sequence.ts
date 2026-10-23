// The shell's `open` command (docker/sandbox/open) tells the console what to show by printing
// ESC ] 7701 ; open ; <file|directory> ; <base64 absolute path> BEL into the PTY. This module finds
// those sequences in the PTY's output, which arrives in arbitrary chunks and is untrusted: any program
// can print the same bytes, so the scanner checks grammar and size and nothing more. The bytes still
// reach the terminal unchanged, which swallows an OSC it does not know.

/** What `open` announced: an absolute container path as printed, and what `open` found there. Untrusted. */
export interface WorkspaceOpen {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/**
 * Scanner state between chunks: the unfinished tail of a candidate sequence, from its ESC. Empty in
 * the common case, and never longer than OPEN_SEQUENCE_MAX_BYTES.
 */
export interface OpenScan {
  readonly carry: Uint8Array;
}

export const OPEN_SCAN_START: OpenScan = { carry: new Uint8Array(0) };

/** PATH_MAX 4096 as base64 (5464) plus the prefix, kind and terminator, rounded up. */
export const OPEN_SEQUENCE_MAX_BYTES = 6 * 1024;

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const PREFIX = new TextEncoder().encode("\u001B]7701;");

/** `open;file;` and base64: a byte outside this set abandons the candidate, as a terminal would. */
const isBodyByte = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2b ||
  byte === 0x2f ||
  byte === 0x3d ||
  byte === 0x3b;

type Candidate =
  | { readonly type: "partial" }
  | { readonly type: "rejected"; readonly resume: number }
  | {
      readonly type: "complete";
      readonly body: Uint8Array;
      readonly resume: number;
    };

const PARTIAL: Candidate = { type: "partial" };

/** The candidate starting at the ESC at `start`. Every rejection depends on offsets from `start` only, so a split never changes the outcome. */
const candidateAt = (data: Uint8Array, start: number): Candidate => {
  for (let offset = 0; offset < PREFIX.length; offset += 1) {
    if (start + offset >= data.length) {
      return PARTIAL;
    }
    if (data[start + offset] !== PREFIX[offset]) {
      return { type: "rejected", resume: start + 1 };
    }
  }
  const bodyStart = start + PREFIX.length;
  for (let at = bodyStart; at < data.length; at += 1) {
    if (at - start >= OPEN_SEQUENCE_MAX_BYTES) {
      return { type: "rejected", resume: at };
    }
    const byte = data[at];
    if (byte === BEL) {
      return {
        type: "complete",
        body: data.subarray(bodyStart, at),
        resume: at + 1,
      };
    }
    if (byte === ESC) {
      if (at + 1 >= data.length) {
        return PARTIAL;
      }
      return data[at + 1] === BACKSLASH
        ? {
            type: "complete",
            body: data.subarray(bodyStart, at),
            resume: at + 2,
          }
        : { type: "rejected", resume: at };
    }
    if (!isBodyByte(byte)) {
      return { type: "rejected", resume: at };
    }
  }
  return PARTIAL;
};

const ascii = new TextDecoder("ascii");
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** "open;file;L3dv..." as a WorkspaceOpen; undefined for another verb or kind, bad base64, non-UTF-8 or a relative path. */
const parseBody = (body: Uint8Array): WorkspaceOpen | undefined => {
  const [verb, kind, encoded, ...rest] = ascii.decode(body).split(";");
  if (
    verb !== "open" ||
    (kind !== "file" && kind !== "directory") ||
    encoded === undefined ||
    encoded === "" ||
    rest.length > 0
  ) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64");
  // Node's decoder skips what it cannot read; only a faithful round trip is base64.
  if (decoded.toString("base64") !== encoded) {
    return undefined;
  }
  let path: string;
  try {
    path = utf8.decode(decoded);
  } catch {
    return undefined;
  }
  return path.startsWith("/") ? { path, kind } : undefined;
};

/**
 * Feeds one PTY chunk through the scanner: the next state and the well-formed `open` sequences that
 * ended in this chunk, in order. The caller forwards the chunk itself unchanged.
 */
export const scanOpens = (
  scan: OpenScan,
  chunk: Uint8Array
): readonly [OpenScan, readonly WorkspaceOpen[]] => {
  if (scan.carry.length === 0 && !chunk.includes(ESC)) {
    return [scan, []];
  }
  let data = chunk;
  if (scan.carry.length > 0) {
    data = new Uint8Array(scan.carry.length + chunk.length);
    data.set(scan.carry);
    data.set(chunk, scan.carry.length);
  }
  const opens: WorkspaceOpen[] = [];
  let from = 0;
  for (;;) {
    const start = data.indexOf(ESC, from);
    if (start === -1) {
      return [OPEN_SCAN_START, opens];
    }
    const candidate = candidateAt(data, start);
    if (candidate.type === "partial") {
      return [{ carry: data.slice(start) }, opens];
    }
    if (candidate.type === "complete") {
      const open = parseBody(candidate.body);
      if (open !== undefined) {
        opens.push(open);
      }
    }
    from = candidate.resume;
  }
};
