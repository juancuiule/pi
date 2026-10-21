import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Stream, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents/agents.ts";
import type { ConversationEvent } from "./conversation-events.ts";
import { ask, callTool, fauxAgents, openSeat } from "./testing/faux.ts";
import {
  redactArtifactArguments,
  redactAttachments,
  traceJson,
} from "./tracing.ts";

/** A tracer that keeps every span it creates. */
const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const parentName = (span: Tracer.NativeSpan) =>
  span.parent._tag === "Some" && span.parent.value._tag === "Span"
    ? span.parent.value.name
    : undefined;

/** Each span as "name < parent", in creation order. */
const tree = (spans: readonly Tracer.NativeSpan[]) =>
  spans
    .filter((span) => !span.name.startsWith("Agents."))
    .map((span) => `${span.name} < ${parentName(span) ?? "-"}`);

const firstOf = <E, R>(stream: Stream.Stream<ConversationEvent, E, R>) =>
  stream
    .pipe(Stream.take(1), Stream.runCollect)
    .pipe(Effect.map((chunk) => [...chunk][0]));

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 5000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep(50);
    }
    throw new Error("waitUntil timed out");
  });

/** The Langfuse session of one run: a fresh Agents layer asking one prompt. */
const sessionOfRun = async () => {
  const { spans, tracer } = recordingTracer();
  const { layer } = fauxAgents([fauxAssistantMessage([fauxText("hi")])]);
  await Effect.runPromise(
    ask("Say hi.").pipe(
      Effect.provide(layer),
      Effect.provideService(Tracer.Tracer, tracer)
    )
  );
  return spans
    .find((span) => span.name === "Seat.ask")
    ?.attributes.get("langfuse.session.id");
};

describe("agent tracing", () => {
  it("leaves an attachment tool's error out of the trace, as it does its results", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("read_attachment", { id: "att_missing" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await Effect.runPromise(
      ask("Read it.").pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );
    const call = spans.find((span) => span.name === "tool read_attachment");
    expect([
      call?.attributes.get("langfuse.observation.level"),
      String(call?.attributes.get("langfuse.observation.status_message")),
    ]).toStrictEqual([
      "ERROR",
      expect.stringMatching(/^\[\d+ characters of attachment text\]$/u),
    ]);
  });

  it("nests model requests and tool calls under the ask", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("artifact_create", { title: "The answer", html: "<p>42</p>" }),
      fauxAssistantMessage([fauxText("42")]),
    ]);

    await Effect.runPromise(
      ask("What is 6 times 7?").pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    expect(tree(spans)).toStrictEqual([
      "Seat.ask < -",
      "generation < Seat.ask",
      "tool artifact_create < Seat.ask",
      "generation < Seat.ask",
    ]);
    const [askSpan, firstRequest, toolCall] = spans.filter(
      (span) => !span.name.startsWith("Agents.")
    );
    expect({
      ask: askSpan?.attributes.get("langfuse.observation.output"),
      model: firstRequest?.attributes.get("langfuse.observation.model.name"),
      toolOutput: toolCall?.attributes.get("langfuse.observation.output"),
    }).toStrictEqual({
      ask: "42",
      model: "faux-1",
      toolOutput: expect.stringContaining("(art_"),
    });
  });

  it("puts a send-driven run's spans on one trace, recorded for feedback", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("artifact_create", { title: "The answer", html: "<p>42</p>" }),
      fauxAssistantMessage([fauxText("42")]),
    ]);
    const traced = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          yield* seat.send("What is 6 times 7?");
          yield* waitUntil(
            seat.running.pipe(Effect.map((running) => !running))
          );
          const snapshot = yield* agents
            .events(seat.id)
            .pipe(Effect.flatMap(firstOf));
          const entry =
            snapshot?.type === "snapshot"
              ? snapshot.entries.find(
                  (each) => each.model?.[0]?.role === "assistant"
                )
              : undefined;
          if (entry === undefined) {
            return yield* Effect.die(new Error("no assistant entry"));
          }
          return yield* agents.entryTrace(seat.id, Number(entry.id));
        })
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    const run = spans.filter(
      (span) => span.name === "generation" || span.name.startsWith("tool ")
    );
    expect(run).toHaveLength(3);
    expect(new Set(run.map((span) => span.traceId)).size).toBe(1);
    expect(traced).toBe(run[0]?.traceId);
    // The send's own span ends at admission; it must never parent the run — feedback scores the run's trace.
    const sent = spans.find((span) => span.name === "Seat.send");
    expect(sent).toBeDefined();
    expect(sent?.traceId).not.toBe(run[0]?.traceId);
  });

  it("starts a fresh trace for the next run of the same conversation", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("artifact_create", { title: "The answer", html: "<p>42</p>" }),
      fauxAssistantMessage([fauxText("42")]),
      fauxAssistantMessage([fauxText("43")]),
    ]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          yield* seat.send("What is 6 times 7?");
          yield* waitUntil(
            seat.running.pipe(Effect.map((running) => !running))
          );
          yield* seat.send("And again?");
          yield* waitUntil(
            seat.running.pipe(Effect.map((running) => !running))
          );
        })
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    const runs = spans.filter((span) => span.name === "generation");
    expect(runs).toHaveLength(3);
    expect(runs[0]?.traceId).toBe(runs[1]?.traceId);
    expect(runs[0]?.traceId).not.toBe(runs[2]?.traceId);
  });

  it("keeps separate runs in separate sessions, though conversation ids restart", async () => {
    const first = await sessionOfRun();
    const second = await sessionOfRun();

    expect(first).toMatch(/^[0-9a-f]{8}-\d+$/u);
    expect(second).toMatch(/^[0-9a-f]{8}-\d+$/u);
    expect(first).not.toBe(second);
  });
});

describe("failed tool calls", () => {
  it("records why the tool failed", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("artifact_update", { id: "art_missing", html: "<p>x</p>" }),
      fauxAssistantMessage([fauxText("There is no such page.")]),
    ]);

    await Effect.runPromise(
      ask("Change the page.").pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    const tool = spans.find((span) => span.name === "tool artifact_update");
    expect({
      level: tool?.attributes.get("langfuse.observation.level"),
      message: tool?.attributes.get("langfuse.observation.status_message"),
    }).toStrictEqual({
      level: "ERROR",
      message: "No artifact art_missing in this conversation.",
    });
  });
});

describe(traceJson, () => {
  it("leaves images out", () => {
    const image = {
      type: "image",
      data: "A".repeat(1000),
      mimeType: "image/png",
    };

    expect(traceJson([image])).toBe(
      '[{"type":"image","data":"[1000 base64 characters]","mimeType":"image/png"}]'
    );
  });
});

describe("artifact tool arguments", () => {
  it("leaves a page's HTML out of the traced input", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("artifact_create", {
        title: "Report",
        html: "<h1>secret page</h1>",
      }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await Effect.runPromise(
      ask("Make a page.").pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );
    const call = spans.find((span) => span.name === "tool artifact_create");
    const input = String(call?.attributes.get("langfuse.observation.input"));
    expect(input).not.toContain("secret page");
    expect(input).toContain("Report");
    expect(input).toContain("[20 characters of HTML]");
  });
});

describe(redactArtifactArguments, () => {
  it("replaces a page and each edit's text by their sizes", () => {
    const redacted = redactArtifactArguments("artifact_update", {
      id: "art_1",
      edits: [{ find: "a find", replace: "a replace" }],
      title: "kept",
    });
    const json = JSON.stringify(redacted);
    expect(json).toBe(
      '{"id":"art_1","edits":[{"find":"[6 characters of HTML]","replace":"[9 characters of HTML]"}],"title":"kept"}'
    );
    expect(redactArtifactArguments("bash", { html: "kept" })).toStrictEqual({
      html: "kept",
    });
  });
});

describe(redactAttachments, () => {
  it("leaves out attachment text from messages and the attachment tools' results", () => {
    const messages = redactAttachments([
      {
        role: "user",
        content:
          'Read this.\n\n<attachment id="att_1" name="a.txt" type="text" status="ready" size="1 lines">\n1: secret\n</attachment>',
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read_attachment",
        content: [{ type: "text", text: "1: secret" }],
        isError: false,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "bash",
        content: [{ type: "text", text: "4" }],
        isError: false,
        timestamp: 0,
      },
    ]);
    const json = JSON.stringify(messages);
    expect(json).not.toContain("secret");
    expect(json).toContain("Read this.");
    expect(json).toContain('name=\\"a.txt\\"');
    expect(json).toContain("[9 characters of attachment text]");
    expect(json).toContain('"text":"4"');
  });
});
