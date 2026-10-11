// pi's OutputBuffer.sanitize() strips ESC from the result text, so ANSI colors never reach the web
// console's terminal. This wrapper strips the sequences for the model-facing output itself and keeps
// the raw stream in `details.ansi`, which bypasses sanitization and never reaches the model.
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import type { ShellOutputSkip } from "@earendil-works/pi-durable/env";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

import { createAnsiStripper } from "../ansi.ts";

/** The raw (pre-strip) output stream of a bash call, for the console terminal's ANSI colors. */
export interface AnsiDetails {
  ansi: string;
}

// The same limits pi's bash spills at (repos/pi/packages/durable/src/truncate.ts exports them only
// internally); the raw copy is display-only, so a coarse tail is enough.
const RAW_MAX_BYTES = 50 * 1024;
const RAW_MAX_LINES = 2000;

const swallow = () => {
  // The commit can reject after the call settles; nothing depends on it.
};

const boundRawTail = (text: string): string => {
  if (text.length <= RAW_MAX_BYTES) {
    const lines = text.split("\n");
    return lines.length <= RAW_MAX_LINES
      ? text
      : lines.slice(-RAW_MAX_LINES).join("\n");
  }
  // Trim at a line boundary so an escape sequence is not cut mid-way.
  const tail = text.slice(-RAW_MAX_BYTES);
  const newline = tail.indexOf("\n");
  const bounded = newline === -1 ? tail : tail.slice(newline + 1);
  const lines = bounded.split("\n");
  return lines.length <= RAW_MAX_LINES
    ? bounded
    : lines.slice(-RAW_MAX_LINES).join("\n");
};

export const createColorBashTool = () => {
  const inner = createBashTool();
  return {
    ...inner,
    async execute(
      args: Parameters<typeof inner.execute>[0],
      api: ToolExecutionApi,
      context: Context
    ) {
      const stripper = createAnsiStripper();
      const decoder = new TextDecoder();
      let raw = "";
      const output = (
        chunk: string | Uint8Array,
        skipped?: ShellOutputSkip
      ) => {
        const text =
          typeof chunk === "string"
            ? chunk
            : decoder.decode(chunk, { stream: true });
        raw = boundRawTail(raw + text);
        // Details are display-only; the terminal commit settles them. Never await per chunk.
        api
          .details({ ansi: raw } satisfies AnsiDetails, context)
          // oxlint-disable-next-line prefer-await-to-then -- the per-chunk commit is fire-and-forget
          .catch(swallow);
        api.output(stripper.push(text), skipped);
      };
      const wrapped = { ...api, output, outputWindow: undefined };
      try {
        const result = await inner.execute(args, wrapped, context);
        api.output(stripper.end());
        return result;
      } catch (error) {
        api.output(stripper.end());
        throw error;
      }
    },
  };
};

/** `read`, `write`, `edit`, and the ANSI-preserving `bash` — a drop-in for pi's `CodingTools`. */
export const CodingTools = defineExtension({
  name: "coding-tools",
  tools: [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createColorBashTool(),
  ],
});
