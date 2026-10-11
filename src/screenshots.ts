// Keeping the agent's desktop screenshots on the host, after the sandbox is gone.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConversationId } from "@earendil-works/pi-durable";

/** Where a screenshot came from: the sandbox it shows, and the conversation and tool call that took it. */
export interface ScreenshotSource {
  readonly sandboxId: string;
  readonly conversationId: ConversationId;
  readonly callId: string;
}

/** Store a screenshot and return where it went. */
export type SaveScreenshot = (
  png: Uint8Array,
  source: ScreenshotSource
) => Promise<string>;

/** The folder holding one sandbox's screenshots. */
export const screenshotDir = (root: string, sandboxId: string) =>
  path.join(root, sandboxId);

const isFileExists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

/**
 * Save screenshots as `<root>/<sandbox id>/001.png`, `002.png`, and so on, in the order they were taken. A subagent
 * shares its owner's sandbox, so its screenshots land in the same folder.
 */
export const saveScreenshotsTo =
  (root: string): SaveScreenshot =>
  async (png, { sandboxId }) => {
    const dir = screenshotDir(root, sandboxId);
    await mkdir(dir, { recursive: true });
    // `wx` fails when the file exists, so screenshots taken at the same time never overwrite each other.
    for (let number = 1; ; number += 1) {
      const file = path.join(dir, `${String(number).padStart(3, "0")}.png`);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each attempt depends on the previous one failing
        await writeFile(file, png, { flag: "wx" });
        return file;
      } catch (error) {
        if (!isFileExists(error)) {
          throw error;
        }
      }
    }
  };
