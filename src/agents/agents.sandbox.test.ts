import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ask,
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  openSeat,
} from "../testing/faux.ts";

/** A model turn that answers with the last tool result's text and details.ansi, as JSON. */
const showResult: FauxResponseStep = (request) => {
  const result = request.messages.findLast(
    (message) => message.role === "toolResult"
  );
  const text = (result?.content ?? [])
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("");
  const details = result?.details as { ansi?: string } | undefined;
  return fauxAssistantMessage([
    fauxText(JSON.stringify({ text, ansi: details?.ansi })),
  ]);
};

describe("conversation sandboxes", () => {
  it("runs shell tools in the conversation's sandbox, removes it at the end and keeps the Workspace's files", async () => {
    const { layer, sandboxes } = fauxAgents([
      callTool("bash", { command: "echo hi > note.txt && pwd" }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Leave a note.", "shell").pipe(Effect.provide(layer))
    );

    // The tool ran in the Workspace's directory: the Sandbox is gone once the conversation ended, its files are not.
    expect(answer).toContain("effect-pi-workspace-");
    expect(sandboxes.live.size).toBe(0);
    expect([...sandboxes.stored].map((dir) => realpathSync(dir))).toContain(
      answer.trim()
    );
    expect(existsSync(path.join(answer.trim(), "note.txt"))).toBeTruthy();
  });

  it("gives a conversation without a sandbox no environment for shell tools", async () => {
    const { layer, sandboxes } = fauxAgents([
      callTool("bash", { command: "pwd" }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Where are you?", "none").pipe(Effect.provide(layer))
    );

    expect(answer).toContain("error:");
    expect(sandboxes.live.size).toBe(0);
  });

  it("exposes the sandbox to the host while the conversation runs", async () => {
    const { layer } = fauxAgents([
      callTool("write", { path: "out.txt", content: "from the agent" }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    const written = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* openSeat({ sandbox: "shell" });
          yield* conversation.ask("Write a file.");
          const dir = conversation.sandbox?.id ?? "";
          return readFileSync(path.join(dir, "out.txt"), "utf-8");
        })
      ).pipe(Effect.provide(layer))
    );

    expect(written).toBe("from the agent");
  });

  it("strips ANSI from bash output for the model but keeps the raw stream in details.ansi", async () => {
    const { layer } = fauxAgents([
      callTool("bash", {
        command: "printf '\\033[31mred\\033[0m plain\\n'",
      }),
      showResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Run a colored echo.", "shell").pipe(Effect.provide(layer))
    );

    expect(JSON.parse(answer)).toStrictEqual({
      text: "red plain\n",
      ansi: "\u001B[31mred\u001B[0m plain\n",
    });
  });
});

describe("Upgrade", () => {
  it("adds the Level's tools to the conversation's own, and tells the agent what machine it has", async () => {
    const { layer } = fauxAgents([offered, offered]);

    const [before, after] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat({ sandbox: "none" });
          const first = yield* seat.ask("What can you do?");
          yield* seat.upgrade({ level: "shell" });
          const second = yield* seat.ask("And now?");
          return [first, second].map(
            (text) => JSON.parse(text) as { tools: string[]; system: unknown[] }
          );
        })
      ).pipe(Effect.provide(layer))
    );

    expect(before?.tools).toContain("upgrade_workspace");
    expect(before?.tools).not.toContain("bash");
    expect(JSON.stringify(before?.system)).toContain("You have no machine");
    // The chat's own tools stay, the shell's come, and nothing else installed does (no desktop tools).
    expect(after?.tools.toSorted()).toStrictEqual(
      [
        ...new Set([
          ...(before?.tools ?? []),
          "bash",
          "edit",
          "read",
          "write",
          "close_port",
          "expose_port",
        ]),
      ]
        .filter((name) => name !== "desktop_screenshot")
        .toSorted()
    );
    expect(JSON.stringify(after?.system)).toContain("You have a Linux shell");
  });
});
