// Exposed ports: expose_port publishes a port the sandbox serves on a random localhost URL the person can
// open — but only after the person approves, whatever the approval policy. The URL lives while the Sandbox
// does: the person closes it from the header, close_port removes it, an Upgrade or a Pause ends it.
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { Effect, Layer, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { approvalKey } from "../approvals.ts";
import type { ApprovalPolicy } from "../approvals.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import { Search } from "../search/search.ts";
import { Conversations } from "../server/conversations.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  openSeat,
} from "../testing/faux.ts";

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 8000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

const hasRunEnd = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => all.some((event) => event.type === "run_end"))
  );

const toolResultTexts = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) =>
      all.flatMap((event) =>
        event.type === "tool_execution_end" && event.entry !== undefined
          ? (event.entry.model ?? []).flatMap((m) =>
              m.role === "toolResult"
                ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
                : []
            )
          : []
      )
    )
  );

const toolResultErrors = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) =>
      all.flatMap((event) =>
        event.type === "tool_execution_end" && event.entry !== undefined
          ? (event.entry.model ?? []).flatMap((m) =>
              m.role === "toolResult" ? [m.isError === true] : []
            )
          : []
      )
    )
  );

/** Open a Seat at `sandbox` under `approvals`, collect its events, and send the prompt. */
const openConversation = (
  sandbox: SandboxChoice,
  approvals: ApprovalPolicy,
  prompt: string
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const conversation = yield* openSeat({ sandbox, approvals });
    const ref = yield* Ref.make<AgentEvent[]>([]);
    const events = yield* agents.events(conversation.id);
    const scope = yield* Scope.Scope;
    yield* Stream.runForEach(events, (event) =>
      Ref.update(ref, (all) => [...all, event])
    ).pipe(Effect.forkIn(scope));
    yield* conversation.send(prompt);
    return { conversation, ref };
  });

/** A real HTTP service on a random host port — the "service in the sandbox" the agent names. */
const serving = async (body: string) => {
  const server = http.createServer((_request, response) => {
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
};

/** The URL the tool reported in its result text: http://127.0.0.1:<random>/. */
const exposedUrl = (texts: readonly string[]) =>
  texts.join("\n").match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];

const fetchBody = async (url: string) => {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
};

/** True when the port refuses connections — the listener is gone. */
const fetchFails = async (url: string) => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

describe("exposed ports", () => {
  it.each(["ask", "auto"] as const)(
    "expose_port waits for the person under %s, then serves the port at a recorded localhost URL",
    async (approvals) => {
      const service = await serving("hello from the sandbox");
      const { layer } = fauxAgents([
        callTool("expose_port", { port: service.port, label: "dev server" }),
        echoToolResult,
      ]);

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { conversation, ref } = yield* openConversation(
                "shell",
                approvals,
                `expose ${service.port}`
              );
              // Under every policy the call parks for the person and the run cannot end.
              yield* waitUntil(
                conversation.pendingApprovals.pipe(
                  Effect.map((count) => count === 1)
                )
              );
              expect(yield* hasRunEnd(ref)).toBeFalsy();
              expect(yield* toolResultTexts(ref)).toHaveLength(0);

              yield* conversation.decide(
                approvalKey(
                  conversation.id as ConversationId,
                  "call-expose_port"
                ),
                "approve"
              );
              yield* waitUntil(hasRunEnd(ref));

              const texts = yield* toolResultTexts(ref);
              const url = exposedUrl(texts);
              expect(url).toBeDefined();
              expect(
                yield* Effect.promise(() => fetchBody(url as string))
              ).toStrictEqual({ status: 200, body: "hello from the sandbox" });
              // The port is recorded on the conversation's Sandbox.
              expect(conversation.sandbox?.ports).toStrictEqual([
                { port: service.port, label: "dev server", url },
              ]);
            })
          ).pipe(Effect.provide(layer))
        );
      } finally {
        service.server.close();
      }
    }
  );

  it("a denied expose_port binds nothing", async () => {
    const service = await serving("never exposed");
    const { layer } = fauxAgents([
      callTool("expose_port", { port: service.port }),
      echoToolResult,
    ]);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { conversation, ref } = yield* openConversation(
              "shell",
              "auto",
              `expose ${service.port}`
            );
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 1)
              )
            );
            yield* conversation.decide(
              approvalKey(
                conversation.id as ConversationId,
                "call-expose_port"
              ),
              "deny"
            );
            yield* waitUntil(hasRunEnd(ref));
            expect(yield* toolResultErrors(ref)).toStrictEqual([true]);
            expect(conversation.sandbox?.ports ?? []).toHaveLength(0);
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });

  it("always on another call does not approve a waiting expose_port", async () => {
    const service = await serving("still gated");
    const { layer } = fauxAgents([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "touch one.txt" }, { id: "one" }),
          fauxToolCall("expose_port", { port: service.port }, { id: "expose" }),
        ],
        { stopReason: "toolUse" }
      ),
      echoToolResult,
      echoToolResult,
      answer("done"),
    ]);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { conversation, ref } = yield* openConversation(
              "shell",
              "ask",
              `expose ${service.port} and touch a file`
            );
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 2)
              )
            );
            yield* conversation.decide(
              approvalKey(conversation.id as ConversationId, "one"),
              "always"
            );
            // The gated call ran under the new auto policy; expose_port still waits.
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 1)
              )
            );
            yield* conversation.decide(
              approvalKey(conversation.id as ConversationId, "expose"),
              "approve"
            );
            yield* waitUntil(hasRunEnd(ref));
            const texts = yield* toolResultTexts(ref);
            expect(exposedUrl(texts)).toBeDefined();
            expect(conversation.sandbox?.ports).toHaveLength(1);
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });

  it('"always" on expose_port itself approves only that call', async () => {
    const service = await serving("still gated");
    const { layer } = fauxAgents([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "touch one.txt" }, { id: "one" }),
          fauxToolCall("expose_port", { port: service.port }, { id: "expose" }),
        ],
        { stopReason: "toolUse" }
      ),
      echoToolResult,
      echoToolResult,
      answer("done"),
    ]);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { conversation, ref } = yield* openConversation(
              "shell",
              "ask",
              `expose ${service.port} and touch a file`
            );
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 2)
              )
            );
            // A crafted "always" on the person-only card decides that call — but must not flip the
            // policy or sweep the other waiting call.
            yield* conversation.decide(
              approvalKey(conversation.id as ConversationId, "expose"),
              "always"
            );
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 1)
              )
            );
            yield* conversation.decide(
              approvalKey(conversation.id as ConversationId, "one"),
              "approve"
            );
            yield* waitUntil(hasRunEnd(ref));
            const texts = yield* toolResultTexts(ref);
            expect(exposedUrl(texts)).toBeDefined();
            expect(conversation.sandbox?.ports).toHaveLength(1);
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });

  it("close_port frees the URL", async () => {
    const service = await serving("closing soon");
    const { layer } = fauxAgents([
      callTool("expose_port", { port: service.port, label: "dev" }),
      echoToolResult,
      callTool("close_port", { port: service.port }),
      echoToolResult,
    ]);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { conversation, ref } = yield* openConversation(
              "shell",
              "auto",
              `expose ${service.port}`
            );
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 1)
              )
            );
            yield* conversation.decide(
              approvalKey(
                conversation.id as ConversationId,
                "call-expose_port"
              ),
              "approve"
            );
            yield* waitUntil(hasRunEnd(ref));
            const url = exposedUrl(yield* toolResultTexts(ref));
            expect(url).toBeDefined();

            // close_port is not gated: the run ends with the URL dead and the record gone.
            yield* conversation.send("close it");
            yield* waitUntil(
              Ref.get(ref).pipe(
                Effect.map(
                  (all) =>
                    all.filter((event) => event.type === "run_end").length === 2
                )
              )
            );
            expect(conversation.sandbox?.ports ?? []).toHaveLength(0);
            expect(
              yield* Effect.promise(() => fetchFails(url as string))
            ).toBeTruthy();
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });

  it("pausing the conversation closes its ports", async () => {
    const service = await serving("paused away");
    const { layer } = fauxAgents([
      callTool("expose_port", { port: service.port }),
      echoToolResult,
    ]);

    try {
      const url = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const { conversation, ref } = yield* openConversation(
                "shell",
                "auto",
                `expose ${service.port}`
              );
              yield* waitUntil(
                conversation.pendingApprovals.pipe(
                  Effect.map((count) => count === 1)
                )
              );
              yield* conversation.decide(
                approvalKey(
                  conversation.id as ConversationId,
                  "call-expose_port"
                ),
                "approve"
              );
              yield* waitUntil(hasRunEnd(ref));
              const found = exposedUrl(yield* toolResultTexts(ref));
              expect(found).toBeDefined();
              expect(
                yield* Effect.promise(() => fetchBody(found as string))
              ).toStrictEqual({ status: 200, body: "paused away" });
              return found;
            })
          );
        }).pipe(Effect.provide(layer))
      );

      // The Seat's scope closed with `Effect.scoped`: the listener is gone even though
      // the service still runs.
      await sleep(150);
      await expect(fetchFails(url as string)).resolves.toBeTruthy();
    } finally {
      service.server.close();
    }
  });

  it("an Upgrade replaces the sandbox and drops its ports", async () => {
    const service = await serving("upgraded away");
    const { layer } = fauxAgents([
      callTool("expose_port", { port: service.port }),
      echoToolResult,
    ]);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { conversation, ref } = yield* openConversation(
              "shell",
              "auto",
              `expose ${service.port}`
            );
            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 1)
              )
            );
            yield* conversation.decide(
              approvalKey(
                conversation.id as ConversationId,
                "call-expose_port"
              ),
              "approve"
            );
            yield* waitUntil(hasRunEnd(ref));
            const url = exposedUrl(yield* toolResultTexts(ref));
            expect(conversation.sandbox?.ports).toHaveLength(1);

            yield* conversation.upgrade({ level: "desktop" });
            expect(conversation.sandbox?.kind).toBe("desktop");
            expect(conversation.sandbox?.ports ?? []).toHaveLength(0);
            expect(
              yield* Effect.promise(() => fetchFails(url as string))
            ).toBeTruthy();
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });

  it("exposing a port does not signal a sandbox change", async () => {
    const service = await serving("steady sandbox");
    const { layer } = fauxAgents([
      callTool("expose_port", { port: service.port }),
      echoToolResult,
    ]);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { conversation, ref } = yield* openConversation(
              "shell",
              "auto",
              `expose ${service.port}`
            );
            // The console's shell session ends on the second emission: exposing must not produce one.
            const emissions = yield* Ref.make(0);
            const scope = yield* Scope.Scope;
            const changes = yield* conversation.sandboxChanges;
            yield* Stream.runForEach(changes, () =>
              Ref.update(emissions, (count) => count + 1)
            ).pipe(Effect.forkIn(scope));
            yield* Effect.sleep("50 millis");
            expect(yield* Ref.get(emissions)).toBe(1);

            yield* waitUntil(
              conversation.pendingApprovals.pipe(
                Effect.map((count) => count === 1)
              )
            );
            yield* conversation.decide(
              approvalKey(
                conversation.id as ConversationId,
                "call-expose_port"
              ),
              "approve"
            );
            yield* waitUntil(hasRunEnd(ref));
            yield* Effect.sleep("200 millis");
            expect(yield* Ref.get(emissions)).toBe(1);
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });
});

describe("the ports API", () => {
  it("lists open ports on the summary and closes them for the person", async () => {
    const service = await serving("via the api");
    const agents = fauxAgents([answer("ready")]);
    const layer = Conversations.layer({
      idleTimeoutMs: 60_000,
      sweepEveryMs: 60_000,
    }).pipe(Layer.provideMerge(Search.none), Layer.provideMerge(agents.layer));

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversations = yield* Conversations;
            const created = yield* conversations.create({
              sandbox: "shell",
              prompt: "hello",
            });
            const seat = yield* conversations.seat(created.id);
            if (seat === undefined) {
              return yield* Effect.die(new Error("no seat"));
            }

            const exposed = yield* seat.exposePort({ port: service.port });
            expect(exposed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
            // Re-exposing the same port is idempotent: the same URL, no second listener.
            const again = yield* seat.exposePort({
              port: service.port,
              label: "renamed",
            });
            expect(again.url).toBe(exposed.url);

            yield* waitUntil(
              conversations.list.pipe(
                Effect.map((all) => all[0]?.ports?.length === 1)
              )
            );
            const listed = (yield* conversations.list)[0]?.ports?.[0];
            expect(listed).toStrictEqual({
              port: service.port,
              url: exposed.url,
            });
            expect(
              yield* Effect.promise(() => fetchBody(exposed.url))
            ).toStrictEqual({ status: 200, body: "via the api" });

            // The person's close: idempotent, and the URL dies.
            yield* conversations.closePort(created.id, service.port);
            yield* conversations.closePort(created.id, service.port);
            expect(
              yield* Effect.promise(() => fetchFails(exposed.url))
            ).toBeTruthy();
            yield* waitUntil(
              conversations.list.pipe(
                Effect.map((all) => (all[0]?.ports ?? []).length === 0)
              )
            );
          })
        ).pipe(Effect.provide(layer))
      );
    } finally {
      service.server.close();
    }
  });
});
