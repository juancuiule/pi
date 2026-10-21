import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { Agents } from "./agents/agents.ts";
import { Artifacts } from "./artifacts/artifacts.ts";
import { TrustedDomains } from "./artifacts/domains.ts";
import { Attachments } from "./attachments/attachments.ts";
import { Capacity } from "./capacity.ts";
import { DEFAULT_OLLAMA_URL, modelFromConfig, ollamaModel } from "./models.ts";
import { Skills } from "./skills/skills.ts";
import { ask } from "./testing/faux.ts";
import { localSandboxes } from "./testing/sandboxes.ts";

describe(ollamaModel, () => {
  it("reads vision, thinking and num_ctx from Ollama", () => {
    const model = ollamaModel("qwen3.5:4b-64k", DEFAULT_OLLAMA_URL, {
      capabilities: ["completion", "vision", "tools", "thinking"],
      parameters:
        "temperature 1\nnum_ctx                        65536\ntop_k 20",
    });

    expect(model).toMatchObject({
      provider: "ollama",
      baseUrl: "http://192.168.1.20:11434/v1",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 65_536,
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    });
  });

  it("assumes a small context and text only when Ollama reports neither", () => {
    const model = ollamaModel("qwen2.5-coder:7b", DEFAULT_OLLAMA_URL, {
      capabilities: ["completion", "tools"],
    });

    expect(model).toMatchObject({
      input: ["text"],
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 4096,
    });
  });
});

describe(modelFromConfig, () => {
  it("names no model when nothing is configured", async () => {
    await expect(
      Effect.runPromise(modelFromConfig({}))
    ).resolves.toBeUndefined();
  });

  it("picks a provider from its API key, and a model ID overrides the model", async () => {
    const anthropic = await Effect.runPromise(
      modelFromConfig({ hasAnthropicKey: true })
    );
    const vercel = await Effect.runPromise(
      modelFromConfig({ hasGatewayKey: true, modelId: "openai/gpt-5" })
    );

    expect(anthropic?.model).toStrictEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    expect(vercel?.model).toStrictEqual({
      provider: "vercel-ai-gateway",
      modelId: "openai/gpt-5",
    });
  });

  it("picks openai from its key, after anthropic and vercel", async () => {
    const openai = await Effect.runPromise(
      modelFromConfig({ hasOpenAIKey: true })
    );
    const both = await Effect.runPromise(
      modelFromConfig({ hasOpenAIKey: true, hasGatewayKey: true })
    );

    expect(openai?.model).toStrictEqual({
      provider: "openai",
      modelId: "gpt-5.5",
    });
    expect(both?.model.provider).toBe("vercel-ai-gateway");
  });

  it("prefers the named provider over whichever key is set", async () => {
    const setup = await Effect.runPromise(
      modelFromConfig({ provider: "vercel", hasAnthropicKey: true })
    );

    expect(setup?.model).toStrictEqual({
      provider: "vercel-ai-gateway",
      modelId: "alibaba/qwen3.8-27b",
    });
  });
});

// ─── A fake Ollama server ────────────────────────────────────────────────────

const readBody = async (request: IncomingMessage) => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
};

const chunk = (delta: object, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "qwen3.5:4b-64k",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

const toolCallReply = [
  chunk({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: {
          name: "artifact_create",
          arguments: JSON.stringify({
            title: "The answer",
            html: "<p>42</p>",
          }),
        },
      },
    ],
  }),
  chunk({}, "tool_calls"),
];
const textReply = [
  chunk({ role: "assistant", content: "It is 42." }),
  chunk({}, "stop"),
];

/** Answers /api/show like Ollama and plays the given replies on /v1/chat/completions, recording each request. */
const fakeOllama = async (replies: string[][]) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    if (request.url === "/api/show") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          capabilities: ["completion", "tools"],
          parameters: "num_ctx 32768",
        })
      );
      return;
    }
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.setHeader("content-type", "text/event-stream");
    response.end(`${(replies.shift() ?? textReply).join("")}data: [DONE]\n\n`);
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as AddressInfo;
  return { server, requests, url: `http://127.0.0.1:${port}` };
};

describe("an Ollama conversation", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
  });

  it("calls tools through Ollama's OpenAI-compatible API", async () => {
    const ollama = await fakeOllama([toolCallReply, textReply]);
    ({ server } = ollama);

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        // The trailing slash is stripped, as for a .env value ending in one.
        const setup = yield* modelFromConfig({
          provider: "ollama",
          ollamaUrl: `${ollama.url}/`,
        });
        if (setup === undefined) {
          return yield* Effect.die("no model");
        }
        const layer = Agents.layer(setup).pipe(
          Layer.provide(localSandboxes().layer),
          Layer.provide(Skills.none),
          Layer.provide(Attachments.temporary()),
          Layer.provide(Artifacts.temporary()),
          Layer.provide(TrustedDomains.temporary()),
          Layer.provide(Capacity.layer({ seats: 1, shells: 1, desktops: 1 }))
        );
        return yield* ask("What is 40 + 2?").pipe(Effect.provide(layer));
      })
    );

    expect(answer).toBe("It is 42.");
    expect(ollama.requests.map((request) => request.model)).toStrictEqual([
      "qwen3.5:4b-64k",
      "qwen3.5:4b-64k",
    ]);
    const [first, second] = ollama.requests;
    // Ollama-compatible requests: no reasoning effort and no `developer` role.
    expect(JSON.stringify(first)).not.toMatch(/reasoning_effort|"developer"/u);
    // The second request carries the tool's result back to the model.
    expect(second?.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining('Created "The answer" (art_'),
      })
    );
  });
});
