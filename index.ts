// Hello world: an Effect program that runs a pi-durable agent, which spawns a subagent through a tool.
// Uses Anthropic when ANTHROPIC_API_KEY is set, and a scripted faux model otherwise.
// Run: node index.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type AssistantMessage, Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import {
  AssistantEntry,
  type Conversation,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryId,
  type Extension,
  Harness,
  MemoryStorage
} from "@earendil-works/pi-durable"
import { Context, Effect, Layer, Schema } from "effect"

const context = BACKGROUND_CONTEXT

// ─── pi-durable: a tool that spawns a subagent ──────────────────────────────

const answerText = async (conversation: Pick<Conversation, "commit">, answer: EntryId): Promise<string> => {
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answer), context)
  const message = entry?.model?.[0] as AssistantMessage
  return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
}

const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description: "Delegate a self-contained task to a subagent and get its answer back.",
      parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
      replay: "safe",
      execute: async (args, api, callContext) => {
        // The child conversation is owned by this tool call: aborting the call aborts the child.
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
          if (existing !== undefined) return existing.id
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })
          // The child cannot spawn subagents of its own.
          await configure(tx, created.id, { extensions: { remove: [Subagent] } })
          return created.id
        }, callContext)
        const handle = (await api.conversation(child, callContext))!
        const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const
        const settled = await (await handle.submit(request, callContext)).wait(callContext)
        if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`)
        const text = await answerText(api, settled.answer)
        console.log(`  [subagent] ${args.task} -> ${text}`)
        return { content: [{ type: "text", text }] }
      }
    })
  ]
})

// ─── Effect: the agent harness as a service ─────────────────────────────────

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  cause: Schema.Defect()
}) {}

export class Agents extends Context.Service<Agents, {
  ask(prompt: string): Effect.Effect<string, AgentError>
}>()("effect-pi/Agents") {
  static readonly layer = Layer.effect(
    Agents,
    Effect.gen(function*() {
      const models = createModels()
      let model = { provider: "anthropic", modelId: "claude-sonnet-5-5" }
      if (process.env.ANTHROPIC_API_KEY === undefined) {
        yield* Effect.logWarning("ANTHROPIC_API_KEY not set, using a scripted faux model")
        const faux = fauxProvider()
        models.setProvider(faux.provider)
        model = { provider: "faux", modelId: "faux-1" }
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("subagent", { task: "Say hello to Effect." }, { id: "call-1" })], {
            stopReason: "toolUse"
          }),
          fauxAssistantMessage([fauxText("Hello, Effect!")]),
          fauxAssistantMessage([fauxText("The subagent says: Hello, Effect!")])
        ])
      } else {
        models.setProvider(anthropicProvider())
      }

      const registry = createRegistry()
      registry.install(Subagent)

      // The harness is opened when the layer is built and closed when it is torn down.
      const harness = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Harness.open(new MemoryStorage(), { models, registry }, context),
          catch: (cause) => new AgentError({ cause })
        }),
        (harness) => Effect.promise(() => harness.close(context))
      )
      const root = yield* Effect.tryPromise({
        try: () => harness.root(context, { agent: { model } }),
        catch: (cause) => new AgentError({ cause })
      })

      const ask = Effect.fn("Agents.ask")((prompt: string) =>
        Effect.tryPromise({
          try: async () => {
            const settled = await (await root.submit({ type: "input", content: prompt }, context)).wait(context)
            if (settled.status !== "done" || settled.type !== "input") throw new Error(`Run failed: ${settled.status}`)
            return answerText(root, settled.answer)
          },
          catch: (cause) => new AgentError({ cause })
        })
      )

      return Agents.of({ ask })
    })
  )
}

// ─── Program ────────────────────────────────────────────────────────────────

const program = Effect.gen(function*() {
  const agents = yield* Agents
  const prompt = "Use the subagent tool to say hello to Effect, then tell me what it said."
  yield* Effect.log(`user: ${prompt}`)
  const answer = yield* agents.ask(prompt)
  yield* Effect.log(`agent: ${answer}`)
})

Effect.runPromise(program.pipe(Effect.provide(Agents.layer))).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
