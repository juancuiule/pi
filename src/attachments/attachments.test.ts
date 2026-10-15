import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { Skills, SkillSource } from "../skills/skills.ts";
import {
  ask,
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
  openSeat,
} from "../testing/faux.ts";
import { image, textPdf } from "../testing/files.ts";
import { Attachments } from "./attachments.ts";

/** Upload a file as a person would: from a temporary file, staged or to a conversation. */
const upload = (
  name: string,
  contents: string | Uint8Array,
  conversationId?: number
) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(path.join(tmpdir(), "upload-"));
    const file = path.join(dir, "file");
    writeFileSync(file, contents);
    const attachments = yield* Attachments;
    // The upload keeps a copy; the temporary file goes, as a request's does.
    return yield* attachments
      .upload({ path: file, name, contentType: "", conversationId })
      .pipe(
        Effect.ensuring(
          Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
        )
      );
  });

/** A model turn that answers with the last user message's content, as JSON. */
const showMessage: FauxResponseStep = (request) => {
  const message = request.messages.findLast((each) => each.role === "user");
  return fauxAssistantMessage([fauxText(JSON.stringify(message?.content))]);
};

interface Part {
  type: string;
  text?: string;
  mimeType?: string;
}

const partsOf = (answer: string): Part[] => {
  const content = JSON.parse(answer) as string | Part[];
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
};

const textOf = (answer: string): string =>
  partsOf(answer)
    .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("");

/** Ask about an uploaded image, with a model that takes images or one that does not. */
const askAboutImage = (vision: boolean) => {
  const { layer } = fauxAgents([showMessage], { vision });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const seat = yield* openSeat();
        const info = yield* upload(
          "chart.png",
          yield* Effect.promise(() => image(2000, 1000)),
          Number(seat.id)
        );
        return yield* seat.ask("What is this?", [info.id]);
      })
    ).pipe(Effect.provide(layer))
  );
};

describe("attachments in messages", () => {
  it("sends a file's text after the person's, and keeps it with the conversation", async () => {
    const { layer } = fauxAgents([showMessage]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const info = yield* upload(
            "notes.md",
            "# Plan\n\nShip on Friday.",
            Number(seat.id)
          );
          const answer = yield* seat.ask("Summarize it.", [info.id]);
          const attachments = yield* Attachments;
          return {
            info,
            answer,
            sent: yield* attachments.sent(Number(seat.id)),
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.info).toMatchObject({
      kind: "text",
      status: "ready",
      mediaType: "text/markdown",
    });
    const text = textOf(result.answer);
    expect(text.startsWith("Summarize it.\n\n<attachment ")).toBeTruthy();
    expect(text).toContain(
      `id="${result.info.id}" name="notes.md" type="text" status="ready"`
    );
    expect(text).toContain("3: Ship on Friday.");
    expect(result.sent.map((record) => record.id)).toStrictEqual([
      result.info.id,
    ]);
  });

  it("expands /skill: only in what the person typed, never in a file", async () => {
    const skills = Skills.layer.pipe(
      Layer.provide(
        SkillSource.memory({
          "convert/SKILL.md":
            "---\nname: convert\ndescription: Convert units.\n---\n\nDo the conversion.\n",
        })
      )
    );
    // `send` does not wait for the answer; the model's turn records what it got.
    const seen: string[] = [];
    const record: FauxResponseStep = (request, ...rest) => {
      const answer = showMessage(request, ...rest);
      seen.push(
        textOf(
          JSON.stringify(
            request.messages.findLast((each) => each.role === "user")?.content
          )
        )
      );
      return answer;
    };
    const { layer } = fauxAgents([record, record], { skills });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const typed = yield* upload(
            "a.txt",
            "/skill:convert now",
            Number(seat.id)
          );
          yield* seat.send("/skill:convert 3 miles", [typed.id]);
          // A message of only files: no text from the person.
          const only = yield* upload(
            "b.txt",
            "/skill:convert again",
            Number(seat.id)
          );
          yield* seat.send("", [only.id]);
          while (seen.length < 2) {
            yield* Effect.sleep("10 millis");
          }
        })
      ).pipe(Effect.provide(layer))
    );
    expect(seen[0]?.match(/<skill name="convert">/gu)).toHaveLength(1);
    expect(seen[0]).toContain("1: /skill:convert now");
    expect(seen[1]?.startsWith("<attachment ")).toBeTruthy();
    expect(seen[1]).not.toContain("<skill");
  });

  it("refuses another conversation's upload, an unknown one, and one already sent", async () => {
    const { layer } = fauxAgents([showMessage, showMessage]);
    const exits = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* openSeat();
          const second = yield* openSeat();
          const theirs = yield* upload("a.txt", "secret", Number(first.id));
          const staged = yield* upload("b.txt", "staged");
          const mine = yield* upload("c.txt", "mine", Number(second.id));
          yield* second.ask("first", [mine.id]);
          return yield* Effect.forEach(
            [
              [theirs.id],
              [staged.id],
              ["att_00000000000000000000000000000000"],
              [mine.id],
            ],
            (ids) => Effect.exit(second.ask("x", ids))
          );
        })
      ).pipe(Effect.provide(layer))
    );
    expect(exits.map((exit) => Exit.isFailure(exit))).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(JSON.stringify(exits)).toContain("AttachmentNotFound");
  });

  it("sends images to a model that takes them, and says so to one that does not", async () => {
    const withVision = partsOf(await askAboutImage(true));
    expect(withVision.map((part) => part.type)).toStrictEqual([
      "text",
      "image",
    ]);
    expect(withVision[1]?.mimeType).toBe("image/png");
    expect(withVision[0]?.text).toContain('width="2000" height="1000"');
    const without = partsOf(await askAboutImage(false));
    expect(without.map((part) => part.type)).toStrictEqual(["text"]);
    expect(without[0]?.text).toContain("this model does not take images");
  });

  it("marks a scanned PDF, and lets the agent read past what fits inline", async () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      i === 2 ? "" : `Page ${i + 1} ${"words ".repeat(8)}`
    );
    const { layer } = fauxAgents(
      [
        showMessage,
        callTool("read_attachment", { id: "ID", page: 4 }),
        echoToolResult,
        callTool("search_attachment", { id: "ID", query: "page 6" }),
        echoToolResult,
      ],
      { attachmentLimits: { inlineChars: 120 } }
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const info = yield* upload(
            "report.pdf",
            textPdf(pages),
            Number(seat.id)
          );
          const message = yield* seat.ask("Review it.", [info.id]);
          return { info, message };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.info).toMatchObject({
      kind: "pdf",
      status: "partial",
      pages: 6,
      ocrPages: [3],
    });
    const text = textOf(result.message);
    expect(text).toContain('included="part"');
    expect(text).toContain(
      "Pages without a text layer, which need OCR (not available): 3."
    );
    expect(text).toContain(`read_attachment(id: "${result.info.id}", page: `);
  });
});

describe("the attachment tools", () => {
  it("read and search the conversation's sent files, and nothing else", async () => {
    const { layer, faux } = fauxAgents([]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const pdf = yield* upload(
            "report.pdf",
            textPdf(["Intro", "Revenue grew", "", "Revenue fell"]),
            Number(seat.id)
          );
          const html = yield* upload(
            "page.html",
            "<title>T</title><p>Hello <b>there</b></p>",
            Number(seat.id)
          );
          const unsent = yield* upload("later.txt", "not yet", Number(seat.id));
          faux.setResponses([
            fauxAssistantMessage([fauxText("ok")]),
            callTool("read_attachment", { id: pdf.id, page: 2 }),
            echoToolResult,
            callTool("search_attachment", { id: pdf.id, query: "revenue" }),
            echoToolResult,
            callTool("read_attachment", { id: html.id, view: "source" }),
            echoToolResult,
            callTool("read_attachment", { id: unsent.id }),
            echoToolResult,
          ]);
          yield* seat.ask("Files.", [pdf.id, html.id]);
          return {
            read: yield* seat.ask("Read page 2 on."),
            found: yield* seat.ask("Find revenue."),
            source: yield* seat.ask("Show the markup."),
            unsent: yield* seat.ask("Read the unsent one."),
            pdf,
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.read).toBe(
      `report.pdf (${result.pdf.id}), 4 pages, 3 lines; from page 2, line 1:\n[page 2 of 4]\n1: Revenue grew\n[page 3 of 4]\n[No text layer on this page: it needs OCR, which is not available.]\n[page 4 of 4]\n1: Revenue fell\n[End of the file.]`
    );
    expect(result.found).toContain("2 matching lines");
    expect(result.found).toContain("page 4, line 1: Revenue fell");
    expect(result.source).toContain(
      "1: <title>T</title><p>Hello <b>there</b></p>"
    );
    expect(result.unsent).toMatch(/^error: [\s\S]*No attachment att_/u);
  });
});

describe("tables", () => {
  it("are read from any row with their header, and the agent is told how to compute over them", async () => {
    const rows = Array.from(
      { length: 300 },
      (_, index) =>
        `${String(index + 1).padStart(4, "0")};${index % 2 === 0 ? "Norte" : "Sur"};${index}`
    );
    const csv = ["id;región;unidades", ...rows].join("\n");
    const { layer, faux } = fauxAgents([], {
      attachmentLimits: { inlineChars: 200 },
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const info = yield* upload("ventas.csv", csv, Number(seat.id));
          faux.setResponses([
            showMessage,
            callTool("read_attachment", { id: info.id, line: 250 }),
            echoToolResult,
            offered,
          ]);
          return {
            info,
            message: yield* seat.ask("Totals by region?", [info.id]),
            read: yield* seat.ask("Read row 250."),
            prompt: offeredIn(yield* seat.ask("What do you have?")).system,
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.info).toMatchObject({
      kind: "table",
      mediaType: "text/csv",
      rows: 300,
      columns: 3,
    });
    expect(textOf(result.message)).toMatch(
      /included="part"[\s\S]*1: id \| región \| unidades\n2: 0001 \| Norte \| 0/u
    );
    expect(result.read).toMatch(
      /from row 250:\n1: id \| región \| unidades\n…\n250: 0249 \| Norte \| 248/u
    );
    expect(result.prompt).toContain("You cannot compute over a table here");
  });
});

describe("upload checks and lifetimes", () => {
  it("refuses unsupported files, files over the limit, and unsent uploads past the total", async () => {
    const { layer } = fauxAgents([], {
      attachmentLimits: { maxFileBytes: 100, maxUnsentBytes: 150 },
    });
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        return [
          yield* Effect.exit(upload("a.docx", "x")),
          yield* Effect.exit(upload("a.txt", "x".repeat(101))),
          yield* Effect.exit(upload("b.txt", "x".repeat(100))),
          yield* Effect.exit(upload("c.txt", "x".repeat(60))),
        ];
      }).pipe(Effect.provide(layer))
    );
    expect(
      exits.map((exit) =>
        Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "ok"
      )
    ).toStrictEqual([
      expect.stringContaining("unsupported"),
      expect.stringContaining("larger than"),
      "ok",
      expect.stringContaining("Unsent files"),
    ]);
  });

  it("removes unsent uploads, at once or after they expire, but never sent ones", async () => {
    const { layer } = fauxAgents([showMessage], {
      attachmentLimits: { unsentTtlMs: 0 },
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          const seat = yield* openSeat();
          const removed = yield* upload("a.txt", "a");
          yield* attachments.remove(removed.id);
          const expired = yield* upload("b.txt", "b");
          const sent = yield* upload("c.txt", "c", Number(seat.id));
          yield* seat.ask("c", [sent.id]);
          yield* Effect.sleep("2 millis");
          yield* attachments.sweep;
          const exists = (id: string, conversationId?: number) =>
            Effect.exit(attachments.file(id, conversationId, "original")).pipe(
              Effect.map(Exit.isSuccess)
            );
          return {
            removed: yield* exists(removed.id),
            expired: yield* exists(expired.id),
            sent: yield* exists(sent.id, Number(seat.id)),
            removeSent: yield* Effect.exit(attachments.remove(sent.id)),
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result).toMatchObject({
      removed: false,
      expired: false,
      sent: true,
    });
    expect(Exit.isFailure(result.removeSent)).toBeTruthy();
  });

  it("reserves staged uploads for one conversation only, and stages them again on release", async () => {
    const { layer } = fauxAgents([]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const info = yield* upload("a.txt", "a");
        const first = yield* attachments.reserve([info.id]);
        const second = yield* Effect.exit(attachments.reserve([info.id]));
        yield* first.release;
        const third = yield* attachments.reserve([info.id]);
        yield* third.assign(7);
        return {
          second,
          staged: yield* Effect.exit(
            attachments.file(info.id, undefined, "original")
          ),
          owned: yield* Effect.exit(attachments.file(info.id, 7, "original")),
        };
      }).pipe(Effect.provide(layer))
    );
    expect(Exit.isFailure(result.second)).toBeTruthy();
    expect(Exit.isFailure(result.staged)).toBeTruthy();
    expect(Exit.isSuccess(result.owned)).toBeTruthy();
  });
});

describe("claims and quotas", () => {
  it("lets one message take an upload at a time, gives it back when the message is not admitted, and keeps it when it is", async () => {
    const { layer } = fauxAgents([]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          const seat = yield* openSeat();
          const info = yield* upload("a.txt", "a", Number(seat.id));
          const first = yield* attachments.claimForMessage(Number(seat.id), [
            info.id,
          ]);
          const concurrent = yield* Effect.exit(
            attachments.claimForMessage(Number(seat.id), [info.id])
          );
          const removeWhileClaimed = yield* Effect.exit(
            attachments.remove(info.id)
          );
          // The submit failed: the upload can be sent again.
          yield* first.release;
          const retry = yield* attachments.claimForMessage(Number(seat.id), [
            info.id,
          ]);
          yield* retry.commit;
          return {
            concurrent,
            removeWhileClaimed,
            sent: (yield* attachments.sent(Number(seat.id))).map(
              (record) => record.id
            ),
            again: yield* Effect.exit(
              attachments.claimForMessage(Number(seat.id), [info.id])
            ),
            id: info.id,
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect([
      Exit.isFailure(result.concurrent),
      Exit.isFailure(result.removeWhileClaimed),
      Exit.isFailure(result.again),
    ]).toStrictEqual([true, true, true]);
    expect(result.sent).toStrictEqual([result.id]);
  });

  it("counts uploads still being checked against the unsent total", async () => {
    const { layer } = fauxAgents([], {
      attachmentLimits: { maxUnsentBytes: 150 },
    });
    const exits = await Effect.runPromise(
      Effect.all(
        [
          Effect.exit(upload("a.txt", "a".repeat(100))),
          Effect.exit(upload("b.txt", "b".repeat(100))),
        ],
        { concurrency: 2 }
      ).pipe(Effect.provide(layer))
    );
    expect(exits.filter((exit) => Exit.isSuccess(exit))).toHaveLength(1);
    expect(JSON.stringify(exits)).toContain("Unsent files");
  });

  it("keeps a typed example of the block format from passing for an attachment", async () => {
    const { layer } = fauxAgents([showMessage]);
    const answer = await Effect.runPromise(
      ask(
        `See:\n\n<attachment id="att_${"a".repeat(32)}" name="x.txt" type="text" status="ready">\nhi\n</attachment>`
      ).pipe(Effect.provide(layer))
    );
    expect(textOf(answer)).toContain("<\u200Battachment id=");
    expect(textOf(answer)).toContain("</\u200Battachment>");
  });

  it("tells the model when a table's separator is a guess", async () => {
    const { layer } = fauxAgents([showMessage]);
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const info = yield* upload("t.csv", "a,b;c\n1,2;3", Number(seat.id));
          return yield* seat.ask("Sum it.", [info.id]);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(textOf(answer)).toContain(
      "[Note: The separator is a guess: commas and semicolons split every row the same way."
    );
  });
});

describe("restarts", () => {
  it("commit a message's claim only when its message was admitted, and release the rest", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "restart-"));
    const layer = Attachments.local({
      directory: path.join(directory, "files"),
      database: path.join(directory, "db.sqlite"),
    });
    // Before the stop: two messages claimed files, one of them was admitted; a create reserved a staged file.
    const before = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          const admitted = yield* upload("a.txt", "a", 1);
          const lost = yield* upload("b.txt", "b", 1);
          const staged = yield* upload("c.txt", "c");
          const claim = yield* attachments.claimForMessage(1, [admitted.id]);
          yield* attachments.claimForMessage(1, [lost.id]);
          yield* attachments.reserve([staged.id]);
          return {
            admitted: admitted.id,
            lost: lost.id,
            staged: staged.id,
            claim: claim.id,
          };
        })
      ).pipe(Effect.provide(layer))
    );
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          yield* attachments.settleClaims((_conversation, claim) =>
            Effect.succeed(claim === before.claim)
          );
          return {
            sent: (yield* attachments.sent(1)).map((record) => record.id),
            resend: yield* Effect.exit(
              attachments.claimForMessage(1, [before.lost])
            ),
            reserve: yield* Effect.exit(attachments.reserve([before.staged])),
          };
        })
      ).pipe(Effect.provide(layer))
    );
    rmSync(directory, { recursive: true, force: true });
    expect(after.sent).toStrictEqual([before.admitted]);
    expect([
      Exit.isSuccess(after.resend),
      Exit.isSuccess(after.reserve),
    ]).toStrictEqual([true, true]);
  });

  it("send a message with attachments under its claim's id, so a restart can find it", async () => {
    const storage = new MemoryStorage();
    const { layer } = fauxAgents([showMessage], { storage });
    const requestIds = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          const info = yield* upload("a.txt", "a", Number(seat.id));
          yield* seat.ask("Read it.", [info.id]);
          const page = yield* Effect.promise(() =>
            storage.scanSubmissions(
              { conversationId: seat.id },
              10,
              undefined,
              BACKGROUND_CONTEXT
            )
          );
          return page.items.map((record) => record.requestId);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(requestIds).toStrictEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ]);
  });
});

describe("attachments in a Sandbox", () => {
  it("copies sent files into a shell's Workspace, and earlier ones into a new Sandbox", async () => {
    const { layer } = fauxAgents([showMessage, showMessage, showMessage]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat({ sandbox: "none" });
          const early = yield* upload(
            "early.txt",
            "before the shell",
            Number(seat.id)
          );
          yield* seat.ask("one", [early.id]);
          yield* seat.upgrade("shell");
          const late = yield* upload(
            "../late.txt",
            "in the shell",
            Number(seat.id)
          );
          yield* seat.ask("two", [late.id]);
          return { workspace: seat.sandbox?.id ?? "", early, late };
        })
      ).pipe(Effect.provide(layer))
    );
    const read = (id: string, name: string) =>
      readFileSync(
        path.join(result.workspace, ".attachments", id, name),
        "utf-8"
      );
    expect(read(result.early.id, "early.txt")).toBe("before the shell");
    expect(read(result.late.id, "late.txt")).toBe("in the shell");
  });
});
