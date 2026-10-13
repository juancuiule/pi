import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { ask, callTool, fauxAgents } from "./testing/faux.ts";
import { traceJson } from "./tracing.ts";

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
    .find((span) => span.name === "AgentConversation.ask")
    ?.attributes.get("langfuse.session.id");
};

describe("agent tracing", () => {
  it("nests model requests and tool calls under the ask", async () => {
    const { spans, tracer } = recordingTracer();
    const { layer } = fauxAgents([
      callTool("calculate", { op: "multiply", a: 6, b: 7 }),
      fauxAssistantMessage([fauxText("42")]),
    ]);

    await Effect.runPromise(
      ask("What is 6 times 7?").pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    expect(tree(spans)).toStrictEqual([
      "AgentConversation.ask < -",
      "generation < AgentConversation.ask",
      "tool calculate < AgentConversation.ask",
      "generation < AgentConversation.ask",
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
      toolOutput: '[{"type":"text","text":"42"}]',
    });
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
      callTool("calculate", { op: "divide", a: 1, b: 0 }),
      fauxAssistantMessage([fauxText("Cannot divide by zero.")]),
    ]);

    await Effect.runPromise(
      ask("What is 1 / 0?").pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    const tool = spans.find((span) => span.name === "tool calculate");
    expect({
      level: tool?.attributes.get("langfuse.observation.level"),
      message: tool?.attributes.get("langfuse.observation.status_message"),
    }).toStrictEqual({ level: "ERROR", message: "Division by zero" });
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
