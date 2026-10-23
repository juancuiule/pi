import { describe, expect, it } from "vitest";

import {
  OPEN_SCAN_START,
  OPEN_SEQUENCE_MAX_BYTES,
  scanOpens,
} from "./open-sequence.ts";
import type { OpenScan, WorkspaceOpen } from "./open-sequence.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const sequence = (
  kind: string,
  path: string,
  terminator = "\u0007",
  verb = "open"
) =>
  `\u001B]7701;${verb};${kind};${Buffer.from(path).toString("base64")}${terminator}`;

/** Feeds the chunks in order, returning every open found and the final state. */
const scanAll = (chunks: readonly Uint8Array[]) => {
  let scan: OpenScan = OPEN_SCAN_START;
  const opens: WorkspaceOpen[] = [];
  let maxCarry = 0;
  for (const chunk of chunks) {
    const [next, found] = scanOpens(scan, chunk);
    scan = next;
    opens.push(...found);
    maxCarry = Math.max(maxCarry, scan.carry.length);
  }
  return { opens, carry: scan.carry.length, maxCarry };
};

const STREAM = bytes(
  `prompt$ open a.md\r\n${sequence("file", "/workspace/a.md")}` +
    `\u001B[32mgreen\u001B[0m \u001B]0;title\u0007 \u001B]7;file://host/workspace\u0007` +
    `${sequence("directory", "/workspace/src", "\u001B\\")}done\r\n`
);
const STREAM_OPENS = [
  { path: "/workspace/a.md", kind: "file" },
  { path: "/workspace/src", kind: "directory" },
];

describe(scanOpens, () => {
  it("finds a BEL- or ST-terminated sequence in one chunk", () => {
    expect(
      scanAll([bytes(`a${sequence("file", "/workspace/a.md")}b`)])
    ).toStrictEqual({
      opens: [{ path: "/workspace/a.md", kind: "file" }],
      carry: 0,
      maxCarry: 0,
    });
    expect(
      scanAll([bytes(sequence("directory", "/workspace", "\u001B\\"))]).opens
    ).toStrictEqual([{ path: "/workspace", kind: "directory" }]);
  });

  it("finds the same opens however the stream is split in two", () => {
    const offsets = Array.from({ length: STREAM.length + 1 }, (_, i) => i);
    const results = offsets.map((offset) =>
      scanAll([STREAM.subarray(0, offset), STREAM.subarray(offset)])
    );
    expect(results.map(({ opens, carry }) => ({ opens, carry }))).toStrictEqual(
      offsets.map(() => ({ opens: STREAM_OPENS, carry: 0 }))
    );
  });

  it("finds the same opens fed one byte at a time", () => {
    const chunks = Array.from(STREAM, (byte) => Uint8Array.of(byte));
    expect(scanAll(chunks).opens).toStrictEqual(STREAM_OPENS);
  });

  it("round-trips a path with ;, a space, a newline and é", () => {
    const path = "/workspace/odd;name é\nx.md";
    expect(scanAll([bytes(sequence("file", path))]).opens).toStrictEqual([
      { path, kind: "file" },
    ]);
  });

  it("ignores malformed sequences and keeps no carry after them", () => {
    const nonUtf8 = `\u001B]7701;open;file;${Buffer.from([0x2f, 0xff, 0xfe]).toString("base64")}\u0007`;
    const malformed = [
      sequence("file", "/workspace/a.md", "\u0007", "close"),
      sequence("link", "/workspace/a.md"),
      "\u001B]7701;open;file;not*base64\u0007",
      "\u001B]7701;open;file;QQ\u0007",
      "\u001B]7701;open;file;\u0007",
      "\u001B]7701;open;file;L3dvcmtzcGFjZQ==;extra\u0007",
      nonUtf8,
      sequence("file", "workspace/a.md"),
    ];
    expect(
      malformed.map((text) => ({ text, ...scanAll([bytes(text)]) }))
    ).toStrictEqual(
      malformed.map((text) => ({ text, opens: [], carry: 0, maxCarry: 0 }))
    );
  });

  it("drops an oversized candidate and never carries more than the bound", () => {
    const oversized = bytes(
      `${sequence("file", `/workspace/${"a".repeat(OPEN_SEQUENCE_MAX_BYTES)}`)}${sequence("file", "/workspace/b.md")}`
    );
    const whole = scanAll([oversized]);
    const byteByByte = scanAll(
      Array.from(oversized, (byte) => Uint8Array.of(byte))
    );
    const expected = [{ path: "/workspace/b.md", kind: "file" }];
    expect(whole.opens).toStrictEqual(expected);
    expect(byteByByte.opens).toStrictEqual(expected);
    expect(byteByByte.maxCarry).toBeLessThanOrEqual(OPEN_SEQUENCE_MAX_BYTES);
    expect(byteByByte.carry).toBe(0);
  });

  it("abandons a candidate cut off by another escape and finds the next one", () => {
    const text = `\u001B]7701;open;fi\u001B[0m${sequence("file", "/workspace/a.md")}`;
    expect(scanAll([bytes(text)]).opens).toStrictEqual([
      { path: "/workspace/a.md", kind: "file" },
    ]);
  });

  it("finds nothing in other OSC and CSI sequences", () => {
    expect(
      scanAll([
        bytes(
          "\u001B]0;title\u0007\u001B]7;file://h/w\u0007\u001B]770;x\u0007\u001B[1;31mred\u001B[0m\u001B]8;;https://e.x\u001B\\"
        ),
      ])
    ).toStrictEqual({ opens: [], carry: 0, maxCarry: 0 });
  });
});
