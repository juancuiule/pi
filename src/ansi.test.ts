import { describe, expect, it } from "vitest";

import { createAnsiStripper } from "./ansi.ts";

const stripAll = (chunks: readonly string[]): string => {
  const stripper = createAnsiStripper();
  return chunks.map((chunk) => stripper.push(chunk)).join("") + stripper.end();
};

describe(createAnsiStripper, () => {
  it("removes SGR color and weight sequences", () => {
    const cases: [string, string][] = [
      ["\u001B[31mred\u001B[0m", "red"],
      ["\u001B[1;34mbold blue\u001B[0m", "bold blue"],
      ["\u001B[32mgreen", "green"],
      ["plain \u001B[2Kline", "plain line"],
    ];
    expect(cases.map(([input]) => stripAll([input]))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });

  it("completes a sequence split across chunks at any byte boundary", () => {
    const full = "\u001B[1;31mX\u001B[0m";
    const splits = Array.from({ length: full.length - 1 }, (_, i) => [
      full.slice(0, i + 1),
      full.slice(i + 1),
    ]);
    expect(splits.map(([a, b]) => stripAll([a, b]))).toStrictEqual(
      splits.map(() => "X")
    );
  });

  it("removes OSC sequences with BEL or ST terminators", () => {
    const cases: [string, string][] = [
      ["\u001B]8;;http://x\u0007link\u001B]8;;\u0007 rest", "link rest"],
      ["\u001B]0;window title\u0007next", "next"],
      ["\u001B]0;window title\u001B\\next", "next"],
    ];
    expect(cases.map(([input]) => stripAll([input]))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });

  it("removes charset designators and 8-bit CSI", () => {
    const cases: [string, string][] = [
      ["\u001B(Bascii", "ascii"],
      ["\u009B31meight-bit\u009B0m", "eight-bit"],
      ["a\u001Bcreset b", "areset b"],
    ];
    expect(cases.map(([input]) => stripAll([input]))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });

  it("drops a lone trailing ESC and unterminated sequences at end()", () => {
    const cases: [string, string][] = [
      ["done\u001B", "done"],
      ["done\u001B[31", "done"],
      ["done\u001B]0;title", "done"],
    ];
    expect(cases.map(([input]) => stripAll([input]))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });

  it("keeps plain text — including a literal [31m without ESC — and CR/LF/TAB", () => {
    const cases: [string, string][] = [
      ["[31mnot a color[0m", "[31mnot a color[0m"],
      ["a\rb\nc\td", "a\rb\nc\td"],
      ["100%\r", "100%\r"],
    ];
    expect(cases.map(([input]) => stripAll([input]))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});
