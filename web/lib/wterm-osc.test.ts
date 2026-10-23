// Pins what the shell's `open` relies on: the terminal draws nothing for its OSC, whole or split across
// writes, so the sequence can stay in the PTY's bytes and its scrollback. A wterm that echoed unknown OSCs
// would show it raw in the Shell tab. @wterm/core is not a direct dependency, so it is reached through
// @wterm/dom, which ships it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface Bridge {
  init(cols: number, rows: number): void;
  writeRaw(data: Uint8Array): void;
  getCell(row: number, col: number): { readonly char: number };
}

const core = createRequire(
  createRequire(import.meta.url).resolve("@wterm/dom")
);
const { WasmBridge } = (await import(
  pathToFileURL(core.resolve("@wterm/core")).href
)) as { WasmBridge: new (instance: WebAssembly.Instance) => Bridge };
const { instance } = await WebAssembly.instantiate(
  readFileSync(core.resolve("@wterm/core/wasm"))
);

const firstRow = (writes: readonly string[]) => {
  const bridge = new WasmBridge(instance);
  bridge.init(40, 3);
  for (const text of writes) {
    bridge.writeRaw(new TextEncoder().encode(text));
  }
  let row = "";
  for (let column = 0; column < 40; column += 1) {
    const { char } = bridge.getCell(0, column);
    row += char === 0 ? "" : String.fromCodePoint(char);
  }
  return row.trimEnd();
};

const OPEN = "\u001B]7701;open;file;L3dvcmtzcGFjZS9hLm1k";

describe("wterm and the `open` sequence", () => {
  it("draws nothing for it, BEL- or ST-terminated", () => {
    expect(firstRow([`a${OPEN}\u0007b`])).toBe("ab");
    expect(firstRow([`a${OPEN}\u001B\\b`])).toBe("ab");
  });

  it("draws nothing for it split across writes at any offset", () => {
    const text = `a${OPEN}\u0007b`;
    const offsets = Array.from({ length: text.length - 1 }, (_, i) => i + 1);
    expect(
      offsets.map((offset) =>
        firstRow([text.slice(0, offset), text.slice(offset)])
      )
    ).toStrictEqual(offsets.map(() => "ab"));
  });
});
