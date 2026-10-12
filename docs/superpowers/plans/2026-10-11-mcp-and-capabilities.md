# MCP servers and capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents use tools from remote MCP servers (starting with El Gato y La Caja search), and the web console lists skills and MCP servers and supports `/skill:<name>` with autocomplete in both text areas.

**Architecture:** `src/mcp.ts` connects configured Streamable HTTP servers with `@earendil-works/pi-mcp` when the `Agents` layer is built and exposes their tools as one pi-durable extension (`mcp_<server>_<tool>`). `Agents` gains `capabilities` and `expandSkill`; `Conversations` expands `/skill:` on create and send; the API gains `GET /api/capabilities`. The web console adds a capabilities sheet, a skill chip in the transcript and a `/` autocomplete in `Composer`.

**Tech Stack:** TypeScript 7 (Node strip-types), Effect 4, pi-durable, `@earendil-works/pi-mcp` 1.1.0, vitest, Next.js + React + Zustand + TanStack Query + shadcn (base-ui).

**Spec:** `docs/superpowers/specs/2026-10-11-mcp-and-capabilities-design.md`

## Global Constraints

- Use pnpm, never npm or yarn. Pin `@earendil-works/pi-mcp` to exactly `1.1.0` (same as `@earendil-works/pi-env`).
- Read `repos/effect/LLMS.md` before writing Effect code; follow patterns in `src/agents.ts` and `src/server/conversations.ts`.
- Do not import from `repos/`; do not edit files under `repos/`.
- `src/server/api.ts` and `src/errors.ts` must not import pi packages at runtime (web bundles them).
- MCP tool names: `mcp_<server>_<tool>`, characters outside `[A-Za-z0-9_-]` replaced by `_`, cut to 64 characters.
- Server names: `[a-z0-9-]+`.
- The eglc endpoint is `https://search.elgatoylacaja.com/mcp` (Streamable HTTP); `/sse` is not supported by pi-mcp.
- Connect timeout per server: 10 seconds. No reconnect.
- MCP tools are not gated by approvals.
- Tests never call a real model; network tests only in `*.integration.test.ts`, excluded from `pnpm test`/`pnpm check`, run by `pnpm test:integration`.
- Skill message format (shared by CLI and server), exactly: `<skill name="NAME">\n` + instructions + `\n</skill>` and, when there is a request, `\n\n` + request.
- Run `pnpm check` before each commit; lefthook runs format, lint, typecheck and tests on commit. Never skip hooks.
- Commit messages: imperative sentence, no prefix, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on the `feature/mcp-and-capabilities` branch.

## Review Focus

- An MCP server that is reachable but slow or hangs during `initialize` or `tools/list` must not block startup beyond 10s; it becomes `unavailable` with a timeout error. (Task 1 test: "times out a server that never answers".)
- Two MCP tools whose names sanitize to the same tool name: the second is skipped with a warning instead of crashing the registry. (Task 1 test: "skips a tool whose sanitized name collides".)
- A tool call aborted mid-flight (End, interrupt) passes the abort signal to pi-mcp so the HTTP request is cancelled. (Task 1 test: "passes the abort signal to the MCP call".)
- A SKILL.md that itself contains the text `</skill>` must still render as one chip with the full instructions, because the parser splits on the last `\n</skill>` that is followed by end of text or a blank line. (Task 5 test: "keeps a closing tag inside the instructions".)
- `/skill:` typed with an unknown name in the console is rejected with a readable toast, and the typed text stays in the box. (Task 4 server test "an unknown skill is 400 and nothing is sent"; Task 7 `apiError` test.)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/mcp.ts` (create) | Config types, connecting servers, tool naming, the `mcp` extension, server state for the UI |
| `src/mcp.test.ts` (create) | Unit tests against in-memory fake MCP servers |
| `src/testing/mcp.ts` (create) | `fakeMcpServer`: an in-memory MCP server config for tests |
| `src/mcp/eglc.ts` (create) | `eglcTransform` and `htmlToText` |
| `src/mcp/eglc.test.ts` (create) | Transform test against a recorded fixture |
| `src/testing/fixtures/eglc-post.json` (create) | Recorded `get_wordpress_post` result |
| `src/mcp.eglc.integration.test.ts` (create) | Real-server test |
| `mcp.config.ts` (create) | The configured servers (`eglc`) |
| `vitest.config.ts`, `package.json` (modify) | `test:integration`, pi-mcp dependency |
| `src/agents.ts` (modify) | `mcp` option, `capabilities`, `expandSkill` |
| `src/skills.ts` (modify) | `parseSkillCommand`, `formatSkillMessage`, tagged `expandSkillCommand` |
| `src/errors.ts` (modify) | `SkillNotFound` |
| `src/server/conversations.ts` (modify) | Expand `/skill:` on create and send |
| `src/server/api.ts`, `src/server/handlers.ts` (modify) | `GET /api/capabilities`, 400 for `SkillNotFound` |
| `server.ts`, `index.ts` (modify) | Pass `mcp` config |
| `web/lib/skill-message.ts` (create) | `parseSkillMessage` |
| `web/lib/skill-autocomplete.ts` (create) | Pure autocomplete logic |
| `web/lib/draft.ts` (create) | Zustand store to hand a draft to the active composer |
| `web/lib/queries.ts`, `web/lib/api.ts` (modify) | `useCapabilities`, `SkillNotFound` message |
| `web/components/console/transcript.tsx` (modify) | Skill chip |
| `web/components/console/capabilities-sheet.tsx` (create) | The sheet |
| `web/components/console/sidebar.tsx` (modify) | Button opening the sheet |
| `web/components/console/composer.tsx` (modify) | Autocomplete list |
| `web/components/console/message-input.tsx`, `new-conversation.tsx` (modify) | Take drafts |
| `AGENTS.md`, `skills/README.md` (modify) | Docs |

---

### Task 1: MCP connections and the `mcp` extension

**Files:**

- Modify: `package.json` (dependency)
- Create: `src/mcp.ts`
- Create: `src/testing/mcp.ts`
- Test: `src/mcp.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // src/mcp.ts
  export interface McpServerConfig {
    readonly name: string;
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly transform?: (tool: string, result: CallToolResult) => CallToolResult;
    /** Replaces the Streamable HTTP transport; tests pass an in-memory one. */
    readonly transport?: () => McpTransport;
  }
  export interface McpToolInfo { readonly name: string; readonly description: string }
  export interface McpServerState {
    readonly name: string;
    readonly url: string;
    readonly status: "connected" | "unavailable";
    readonly error?: string;
    readonly tools: readonly McpToolInfo[];
  }
  export interface McpConnections {
    readonly servers: readonly McpServerState[];
    /** `undefined` when no server contributed a tool. */
    readonly extension: Extension | undefined;
    close(): Promise<void>;
  }
  export const mcpToolName: (server: string, tool: string) => string;
  export const connectMcpServers: (
    configs: readonly McpServerConfig[],
    options?: { readonly connectTimeoutMs?: number; readonly warn?: (message: string) => void }
  ) => Promise<McpConnections>;
  ```

  ```ts
  // src/testing/mcp.ts
  export interface FakeTool {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
    call(args: Record<string, unknown>, signal: AbortSignal): CallToolResult | Promise<CallToolResult>;
  }
  export const fakeMcpServer: (
    name: string,
    tools: readonly FakeTool[],
    options?: { readonly hang?: boolean; readonly transform?: McpServerConfig["transform"] }
  ) => McpServerConfig;
  ```

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @earendil-works/pi-mcp@1.1.0 --save-exact` Expected: `package.json` dependencies gain `"@earendil-works/pi-mcp": "1.1.0"`.

- [ ] **Step 2: Write the fake server helper**

Create `src/testing/mcp.ts`:

```ts
// An in-memory MCP server for tests: answers initialize, tools/list and tools/call over pi-mcp's in-memory
// transport pair, so MCP code runs without a network.
import type { CallToolResult, JsonRpcRequest } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

import type { McpServerConfig } from "../mcp.ts";

export interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  call(
    args: Record<string, unknown>,
    signal: AbortSignal
  ): CallToolResult | Promise<CallToolResult>;
}

export const fakeMcpServer = (
  name: string,
  tools: readonly FakeTool[],
  options: {
    /** Never answer `initialize`, to test the connect timeout. */
    readonly hang?: boolean;
    readonly transform?: McpServerConfig["transform"];
  } = {}
): McpServerConfig => ({
  name,
  url: `memory://${name}`,
  ...(options.transform === undefined ? {} : { transform: options.transform }),
  transport: () => {
    const pair = createInMemoryTransportPair();
    const calls = new Map<string | number, AbortController>();
    pair.server.onMessage((message) => {
      if (!("method" in message)) {
        return;
      }
      if (message.method === "notifications/cancelled") {
        const params = message.params as { requestId?: string | number };
        if (params.requestId !== undefined) {
          calls.get(params.requestId)?.abort();
        }
        return;
      }
      if (!("id" in message)) {
        return;
      }
      const request = message as JsonRpcRequest;
      const reply = (result: unknown) =>
        pair.server.send({ jsonrpc: "2.0", id: request.id, result });
      queueMicrotask(async () => {
        switch (request.method) {
          case "initialize": {
            if (options.hang === true) {
              return;
            }
            await reply({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name, version: "0.0.0" },
            });
            return;
          }
          case "tools/list": {
            await reply({
              tools: tools.map((tool) => ({
                name: tool.name,
                ...(tool.description === undefined
                  ? {}
                  : { description: tool.description }),
                inputSchema: tool.inputSchema ?? { type: "object" },
              })),
            });
            return;
          }
          case "tools/call": {
            const params = request.params as {
              name: string;
              arguments?: Record<string, unknown>;
            };
            const tool = tools.find((t) => t.name === params.name);
            if (tool === undefined) {
              await reply({
                content: [
                  { type: "text", text: `unknown tool ${params.name}` },
                ],
                isError: true,
              });
              return;
            }
            const controller = new AbortController();
            calls.set(request.id, controller);
            try {
              await reply(
                await tool.call(params.arguments ?? {}, controller.signal)
              );
            } finally {
              calls.delete(request.id);
            }
            return;
          }
          default: {
            await pair.server.send({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32_601,
                message: `Method not found: ${request.method}`,
              },
            });
          }
        }
      });
    });
    void pair.server.start();
    return pair.client;
  },
});
```

If `pi-mcp` names the pair members differently, read `repos/pi/packages/mcp/src/transports/in-memory.ts` (`createInMemoryTransportPair`) and `repos/pi/packages/mcp/test/client.test.ts:19-60` and match them; the test there uses `pair.server`.

- [ ] **Step 3: Write the failing tests**

Create `src/mcp.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { connectMcpServers, mcpToolName } from "./mcp.ts";
import { fakeMcpServer } from "./testing/mcp.ts";

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

const echo = fakeMcpServer("test", [
  {
    name: "echo",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    call: (args) => text(`echo: ${String(args.text)}`),
  },
  {
    name: "fail",
    call: () => ({ ...text("it broke"), isError: true }),
  },
]);

const executeOf = async (
  connections: Awaited<ReturnType<typeof connectMcpServers>>,
  name: string
) => {
  const tool = connections.extension?.tools?.find((t) => t.name === name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return (args: Record<string, unknown>, signal?: AbortSignal) =>
    tool.execute(args as never, {} as never, { abortSignal: signal } as never);
};

describe(mcpToolName, () => {
  it("prefixes, sanitizes and caps the name", () => {
    expect(mcpToolName("eglc", "get_wordpress_post")).toBe(
      "mcp_eglc_get_wordpress_post"
    );
    expect(mcpToolName("a-b", "x.y z")).toBe("mcp_a-b_x_y_z");
    expect(mcpToolName("s", "t".repeat(100))).toHaveLength(64);
  });
});

describe(connectMcpServers, () => {
  it("lists a connected server's tools and calls them", async () => {
    const connections = await connectMcpServers([echo]);
    try {
      expect(connections.servers).toStrictEqual([
        {
          name: "test",
          url: "memory://test",
          status: "connected",
          tools: [
            { name: "echo", description: "Echo the text back" },
            { name: "fail", description: "" },
          ],
        },
      ]);
      const run = await executeOf(connections, "mcp_test_echo");
      const result = await run({ text: "hi" });
      expect(result.content).toStrictEqual([
        { type: "text", text: "echo: hi" },
      ]);
    } finally {
      await connections.close();
    }
  });

  it("turns isError into a thrown error with the tool's text", async () => {
    const connections = await connectMcpServers([echo]);
    try {
      const run = await executeOf(connections, "mcp_test_fail");
      await expect(run({})).rejects.toThrow("it broke");
    } finally {
      await connections.close();
    }
  });

  it("applies the server's transform before the model sees the result", async () => {
    const transformed = fakeMcpServer(
      "t",
      [{ name: "echo", call: () => text("raw") }],
      {
        transform: (tool, result) =>
          tool === "echo" ? text("shaped") : result,
      }
    );
    const connections = await connectMcpServers([transformed]);
    try {
      const run = await executeOf(connections, "mcp_t_echo");
      expect((await run({})).content).toStrictEqual([
        { type: "text", text: "shaped" },
      ]);
    } finally {
      await connections.close();
    }
  });

  it("records an unreachable server as unavailable and keeps the others", async () => {
    const warnings: string[] = [];
    const down = {
      name: "down",
      url: "memory://down",
      transport: () => {
        throw new Error("connection refused");
      },
    };
    const connections = await connectMcpServers([down, echo], {
      warn: (message) => warnings.push(message),
    });
    try {
      expect(connections.servers[0]).toStrictEqual({
        name: "down",
        url: "memory://down",
        status: "unavailable",
        error: "connection refused",
        tools: [],
      });
      expect(connections.servers[1]?.status).toBe("connected");
      expect(connections.extension?.tools?.map((t) => t.name)).toStrictEqual([
        "mcp_test_echo",
        "mcp_test_fail",
      ]);
      expect(warnings.join("\n")).toContain("down");
    } finally {
      await connections.close();
    }
  });

  it("times out a server that never answers", async () => {
    const hanging = fakeMcpServer("slow", [], { hang: true });
    const started = Date.now();
    const connections = await connectMcpServers([hanging], {
      connectTimeoutMs: 50,
      warn: () => {},
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(connections.servers[0]?.status).toBe("unavailable");
    expect(connections.servers[0]?.error).toContain("timed out");
    expect(connections.extension).toBeUndefined();
    await connections.close();
  });

  it("skips a tool whose sanitized name collides", async () => {
    const warnings: string[] = [];
    const clash = fakeMcpServer("c", [
      { name: "a.b", call: () => text("first") },
      { name: "a_b", call: () => text("second") },
    ]);
    const connections = await connectMcpServers([clash], {
      warn: (message) => warnings.push(message),
    });
    try {
      expect(connections.extension?.tools?.map((t) => t.name)).toStrictEqual([
        "mcp_c_a_b",
      ]);
      expect(warnings.join("\n")).toContain("a_b");
    } finally {
      await connections.close();
    }
  });

  it("passes the abort signal to the MCP call", async () => {
    let aborted = false;
    const slow = fakeMcpServer("s", [
      {
        name: "wait",
        call: (_args, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve(text("stopped"));
            });
          }),
      },
    ]);
    const connections = await connectMcpServers([slow]);
    try {
      const run = await executeOf(connections, "mcp_s_wait");
      const controller = new AbortController();
      const call = run({}, controller.signal);
      setTimeout(() => controller.abort(new Error("end")), 20);
      await expect(call).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(aborted).toBeTruthy();
    } finally {
      await connections.close();
    }
  });

  it("has no extension and nothing to close without servers", async () => {
    const connections = await connectMcpServers([]);
    expect(connections.servers).toStrictEqual([]);
    expect(connections.extension).toBeUndefined();
    await connections.close();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp.test.ts` Expected: FAIL, cannot resolve `./mcp.ts`.

- [ ] **Step 5: Implement `src/mcp.ts`**

```ts
// Remote MCP servers as agent tools. Each configured server is connected over Streamable HTTP when the Agents layer
// is built; its tools become one pi-durable extension, named `mcp_<server>_<tool>`. Calls run on the host, so every
// conversation has them, sandbox or not. A server that cannot be reached is recorded as unavailable and contributes
// no tools; there is no reconnect, a restart retries.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import {
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type {
  CallToolResult,
  McpTransport,
  Tool,
} from "@earendil-works/pi-mcp";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_TOOL_NAME = 64;

export interface McpServerConfig {
  /** `[a-z0-9-]+`; part of every tool name. */
  readonly name: string;
  /** The Streamable HTTP endpoint. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Rewrite a tool's result before the model sees it. */
  readonly transform?: (tool: string, result: CallToolResult) => CallToolResult;
  /** Replaces the Streamable HTTP transport; tests pass an in-memory one. */
  readonly transport?: () => McpTransport;
}

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
}

export interface McpServerState {
  readonly name: string;
  readonly url: string;
  readonly status: "connected" | "unavailable";
  readonly error?: string;
  readonly tools: readonly McpToolInfo[];
}

export interface McpConnections {
  readonly servers: readonly McpServerState[];
  /** `undefined` when no server contributed a tool. */
  readonly extension: Extension | undefined;
  close(): Promise<void>;
}

/** Providers accept at most 64 characters of `[A-Za-z0-9_-]` in a tool name. */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp_${server}_${tool}`
    .replaceAll(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, MAX_TOOL_NAME);

const withTimeout = async <A>(promise: Promise<A>, ms: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Connected {
  readonly config: McpServerConfig;
  readonly client: McpClient;
  readonly tools: readonly Tool[];
}

const connect = async (
  config: McpServerConfig,
  timeoutMs: number
): Promise<Connected> => {
  const client = new McpClient({ name: "effect-pi", version: "1.0.0" });
  try {
    const transport =
      config.transport?.() ??
      new StreamableHttpTransport({
        url: config.url,
        ...(config.headers === undefined
          ? {}
          : { headers: { ...config.headers } }),
      });
    const tools = await withTimeout(
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      timeoutMs
    );
    return { config, client, tools };
  } catch (error) {
    await client.close().catch((): void => undefined);
    throw error;
  }
};

const textOf = (result: CallToolResult): string =>
  toLlmContent(result)
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n");

const toolFor = (
  server: Connected,
  tool: Tool,
  name: string
): ToolRegistration =>
  defineTool({
    name,
    description: `[${server.config.name}] ${tool.description ?? tool.name}`,
    // Providers require an object schema, and some reject one without `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: "object",
      properties: tool.inputSchema.properties ?? {},
    }),
    execute: async (args, _api, context) => {
      const raw = await server.client.callTool(tool.name, args, {
        ...(context.abortSignal === undefined
          ? {}
          : { signal: context.abortSignal }),
      });
      const result = server.config.transform?.(tool.name, raw) ?? raw;
      // MCP reports tool failures in the result; the model sees them as a failed call.
      if (result.isError === true) {
        throw new Error(textOf(result) || `${tool.name} failed`);
      }
      return { content: toLlmContent(result) };
    },
  });

export const connectMcpServers = async (
  configs: readonly McpServerConfig[],
  options: {
    readonly connectTimeoutMs?: number;
    readonly warn?: (message: string) => void;
  } = {}
): Promise<McpConnections> => {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const settled = await Promise.allSettled(
    configs.map((config) => connect(config, timeoutMs))
  );

  const servers: McpServerState[] = [];
  const connected: Connected[] = [];
  const tools: ToolRegistration[] = [];
  const names = new Set<string>();
  for (const [index, outcome] of settled.entries()) {
    const config = configs[index] as McpServerConfig;
    if (outcome.status === "rejected") {
      const error = messageOf(outcome.reason);
      warn(
        `MCP server ${config.name} (${config.url}) is unavailable: ${error}`
      );
      servers.push({
        name: config.name,
        url: config.url,
        status: "unavailable",
        error,
        tools: [],
      });
      continue;
    }
    const server = outcome.value;
    connected.push(server);
    for (const tool of server.tools) {
      const name = mcpToolName(config.name, tool.name);
      if (names.has(name)) {
        warn(
          `MCP server ${config.name}: skipped tool ${tool.name}, its name ${name} is taken`
        );
        continue;
      }
      names.add(name);
      tools.push(toolFor(server, tool, name));
    }
    servers.push({
      name: config.name,
      url: config.url,
      status: "connected",
      tools: server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
      })),
    });
  }

  return {
    servers,
    extension:
      tools.length === 0 ? undefined : defineExtension({ name: "mcp", tools }),
    close: async () => {
      await Promise.all(
        connected.map((server) =>
          server.client.close().catch((): void => undefined)
        )
      );
    },
  };
};
```

Notes for the implementer:

- `context.abortSignal` is the field `src/approvals.ts` uses on the tool `context`; keep it.
- If `Type.Unsafe` or `defineTool` typing rejects the dynamic schema, look at how `repos/pi/packages/mcp/README.md` ("Tools for an LLM") builds `parameters` and keep the same shape; cast the registration to `ToolRegistration` only if the generic inference is the problem.
- In "skips a tool whose sanitized name collides", the `servers[].tools` list still shows both tools (it reports what the server offers); only the extension skips the duplicate.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp.test.ts` Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
pnpm check
git add package.json pnpm-lock.yaml src/mcp.ts src/mcp.test.ts src/testing/mcp.ts
git commit -m "Connect MCP servers and expose their tools as an extension

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: MCP in `Agents`, and `Agents.capabilities`

**Files:**

- Modify: `src/agents.ts` (layer options ~line 282, service interface ~line 225, `start` extensions ~line 453, returned service ~line 640)
- Modify: `src/testing/faux.ts:18-40` (`fauxAgents` options type)
- Test: `src/agents.mcp.test.ts` (create)

**Interfaces:**

- Consumes: `connectMcpServers`, `McpServerConfig`, `McpServerState` from Task 1.
- Produces:

  ```ts
  // src/agents.ts
  export interface Capabilities {
    readonly skills: readonly { readonly name: string; readonly description: string; readonly modelInvocable: boolean }[];
    readonly mcp: readonly McpServerState[];
  }
  // Agents service gains:
  readonly capabilities: Effect.Effect<Capabilities>;
  // Agents.layer options gain:
  readonly mcp?: readonly McpServerConfig[];
  ```

- [ ] **Step 1: Write the failing test**

Create `src/agents.mcp.test.ts`:

```ts
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { loadSkills } from "./skills.ts";
import { ask, callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";
import { fakeMcpServer } from "./testing/mcp.ts";

const echo = fakeMcpServer("test", [
  {
    name: "echo",
    description: "Echo the text back",
    call: (args) => ({
      content: [{ type: "text", text: `echo: ${String(args.text)}` }],
    }),
  },
]);

describe("Agents with MCP servers", () => {
  it("lets a chat conversation call an MCP tool", async () => {
    const agents = fauxAgents(
      [callTool("mcp_test_echo", { text: "hola" }), echoToolResult],
      {
        mcp: [echo],
      }
    );
    const answer = await Effect.runPromise(
      ask("echo hola").pipe(Effect.provide(agents.layer))
    );
    expect(answer).toContain("echo: hola");
  });

  it("reports skills and MCP servers as capabilities", async () => {
    const { skills } = loadSkills("skills");
    const agents = fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
      skills,
      mcp: [
        echo,
        {
          name: "down",
          url: "memory://down",
          transport: () => {
            throw new Error("refused");
          },
        },
      ],
    });
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Agents;
        return yield* service.capabilities;
      }).pipe(Effect.provide(agents.layer))
    );
    expect(capabilities.skills.map((s) => s.name)).toStrictEqual(
      skills.map((s) => s.name)
    );
    expect(
      capabilities.skills.every((s) => typeof s.modelInvocable === "boolean")
    ).toBeTruthy();
    expect(capabilities.mcp.map((s) => [s.name, s.status])).toStrictEqual([
      ["test", "connected"],
      ["down", "unavailable"],
    ]);
  });
});
```

`echoToolResult` (in `src/testing/faux.ts`) answers with the last tool result's text, so the answer contains `echo: hola`. Check its exact output format in `src/testing/faux.ts` and adjust the `toContain` if it prefixes text.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/agents.mcp.test.ts` Expected: FAIL, type error / `mcp` not an option, `capabilities` undefined.

- [ ] **Step 3: Implement**

In `src/testing/faux.ts`, widen the `fauxAgents` options:

```ts
    /** MCP servers, usually `fakeMcpServer`s. */
    readonly mcp?: readonly McpServerConfig[];
```

(import `type { McpServerConfig } from "../mcp.ts"`; options are already spread into `Agents.layer`).

In `src/agents.ts`:

1. Imports: `import { connectMcpServers } from "./mcp.ts";` and `import type { McpServerConfig, McpServerState } from "./mcp.ts";`.
2. Export the type:

```ts
export interface Capabilities {
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    /** False for skills with `disable-model-invocation`: only `/skill:<name>` loads them. */
    readonly modelInvocable: boolean;
  }[];
  readonly mcp: readonly McpServerState[];
}
```

3. In the service interface add:

```ts
    /** The skills and MCP servers conversations can use, for the console. */
    readonly capabilities: Effect.Effect<Capabilities>;
```

4. In `layer` options add:

```ts
    /** Remote MCP servers; connected when the layer is built, closed when it is torn down. */
    readonly mcp?: readonly McpServerConfig[];
```

5. In the layer body, right after `skillExtensions` are installed:

```ts
// Connected before the harness opens, so the tools are registered when conversations start.
const mcp =
  yield *
  Effect.acquireRelease(
    Effect.promise(() => connectMcpServers(options.mcp ?? [])),
    (connections) => Effect.promise(() => connections.close())
  );
const mcpExtensions = mcp.extension === undefined ? [] : [mcp.extension];
for (const extension of mcpExtensions) {
  registry.install(extension);
}
```

`connectMcpServers` never rejects (failures become `unavailable`), so `Effect.promise` is right.

6. In `start`, add `...mcpExtensions,` to the `extensions` array after `...skillExtensions,`.
7. Before `return Agents.of({`:

```ts
const capabilities = Effect.succeed<Capabilities>({
  skills: skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    modelInvocable: !skill.disableModelInvocation,
  })),
  mcp: mcp.servers,
});
```

and add `capabilities` to the object passed to `Agents.of`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/agents.mcp.test.ts && pnpm test` Expected: PASS; all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
pnpm check
git add src/agents.ts src/testing/faux.ts src/agents.mcp.test.ts
git commit -m "Give conversations the configured MCP servers' tools and report capabilities

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `eglc` server, its transform, and the integration test

**Files:**

- Create: `src/mcp/eglc.ts`
- Create: `src/testing/fixtures/eglc-post.json`
- Test: `src/mcp/eglc.test.ts`
- Create: `mcp.config.ts`
- Create: `src/mcp.eglc.integration.test.ts`
- Modify: `vitest.config.ts`, `package.json` (script), `server.ts`, `index.ts`

**Interfaces:**

- Consumes: `McpServerConfig` (Task 1), `Agents.layer({ mcp })` (Task 2).
- Produces:

  ```ts
  // src/mcp/eglc.ts
  export const htmlToText: (html: string) => string;
  export const eglcTransform: (tool: string, result: CallToolResult) => CallToolResult;
  // mcp.config.ts
  export const mcpServers: readonly McpServerConfig[];
  ```

- [ ] **Step 1: Record the fixture**

The recording script runs once and is not committed. Create a temporary file `record-eglc.ts` in the repo root (it must live in the repo so it resolves `@earendil-works/pi-mcp`):

```ts
import { writeFileSync } from "node:fs";

import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";

const client = new McpClient({ name: "effect-pi", version: "1.0.0" });
await client.connect(
  new StreamableHttpTransport({ url: "https://search.elgatoylacaja.com/mcp" })
);
const result = await client.callTool("get_wordpress_post", {
  permalink: "la-ciencia-del-sueno",
});
writeFileSync(
  "src/testing/fixtures/eglc-post.json",
  `${JSON.stringify(result, null, 2)}\n`
);
await client.close();
```

Run: `mkdir -p src/testing/fixtures && node record-eglc.ts && rm record-eglc.ts` Expected: `src/testing/fixtures/eglc-post.json` exists, a `CallToolResult` with one text block of ~31k characters whose JSON has `id_post: 870`.

- [ ] **Step 2: Write the failing test**

Create `src/mcp/eglc.test.ts`:

```ts
import { readFileSync } from "node:fs";

import type { CallToolResult } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";

import { eglcTransform, htmlToText } from "./eglc.ts";

const fixture = JSON.parse(
  readFileSync("src/testing/fixtures/eglc-post.json", "utf-8")
) as CallToolResult;
const textOf = (result: CallToolResult) =>
  result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

describe(htmlToText, () => {
  it("keeps paragraphs, drops tags and decodes entities", () => {
    expect(
      htmlToText(
        "<p><strong>Hola</strong> &amp; chau</p>\n<p>dos&nbsp;<em>líneas</em><br />tres &#8220;x&#8221;</p>"
      )
    ).toBe("Hola & chau\n\ndos líneas\ntres “x”");
  });
});

describe(eglcTransform, () => {
  it("shrinks get_wordpress_post to the article and its metadata", () => {
    const shaped = eglcTransform("get_wordpress_post", fixture);
    const post = JSON.parse(textOf(shaped)) as Record<string, unknown>;
    expect(Object.keys(post)).toStrictEqual([
      "id_post",
      "title",
      "permalink",
      "date",
      "authors",
      "tags",
      "excerpt",
      "content",
    ]);
    expect(post.id_post).toBe(870);
    expect(post.title).toBe("La ciencia del sueño");
    expect(post.authors).toStrictEqual(["Facundo Alvarez Heduan"]);
    expect(post.tags).toContain("sueño");
    expect(post.content).toContain("Al principio eran brujas");
    expect(String(post.content)).not.toContain("<p>");
    // The body appears once.
    expect(String(post.content).split("Al principio eran brujas")).toHaveLength(
      2
    );
    expect(textOf(shaped).length).toBeLessThan(textOf(fixture).length / 3);
  });

  it("passes other tools and unparseable results through", () => {
    const search: CallToolResult = {
      content: [{ type: "text", text: '{"results":[]}' }],
    };
    expect(eglcTransform("search", search)).toBe(search);
    const broken: CallToolResult = {
      content: [{ type: "text", text: "Post not found" }],
    };
    expect(eglcTransform("get_wordpress_post", broken)).toBe(broken);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/mcp/eglc.test.ts` Expected: FAIL, cannot resolve `./eglc.ts`.

- [ ] **Step 4: Implement `src/mcp/eglc.ts`**

```ts
// El Gato y La Caja's search MCP. Its get_wordpress_post returns the post body three times as HTML plus WordPress
// internals (~31k characters for ~7k of text); the transform keeps the article once, as text, with the metadata an
// agent needs, including `id_post`, the id get_recommendations takes.
import type { CallToolResult } from "@earendil-works/pi-mcp";

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decode = (text: string): string =>
  text.replaceAll(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu,
    (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    }
  );

/** Paragraphs become blank-line separated, `<br>` a newline; every other tag is dropped. */
export const htmlToText = (html: string): string =>
  decode(
    html
      .replaceAll(/<br\s*\/?>/giu, "\n")
      .replaceAll(/<\/(p|h[1-6]|li|blockquote|address)>/giu, "\n\n")
      .replaceAll(/<[^>]+>/gu, "")
  )
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

interface WordPressPost {
  readonly id_post: number;
  readonly title: string;
  readonly permalink: string;
  readonly excerpt?: string;
  readonly content: string;
  readonly date_machine?: { readonly date_simple?: string };
  readonly date?: string;
  readonly credits?: {
    readonly autores?: readonly { readonly name: string }[];
  };
  readonly tags?: readonly { readonly name: string }[] | string;
}

const shapePost = (post: WordPressPost) => ({
  id_post: post.id_post,
  title: post.title,
  permalink: post.permalink,
  date: post.date_machine?.date_simple ?? post.date ?? "",
  authors: (post.credits?.autores ?? []).map((author) => author.name),
  tags: Array.isArray(post.tags) ? post.tags.map((tag) => tag.name) : [],
  excerpt: post.excerpt ?? "",
  content: htmlToText(post.content),
});

export const eglcTransform = (
  tool: string,
  result: CallToolResult
): CallToolResult => {
  if (tool !== "get_wordpress_post" || result.isError === true) {
    return result;
  }
  const [block] = result.content;
  if (block?.type !== "text") {
    return result;
  }
  try {
    const post = JSON.parse(block.text) as WordPressPost;
    if (typeof post.content !== "string" || typeof post.id_post !== "number") {
      return result;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(shapePost(post)) }],
    };
  } catch {
    return result;
  }
};
```

If the fixture's `tags` field is not an array of `{ name }` (check the recorded JSON), adapt `shapePost` to its real shape so the test's `toContain("sueño")` holds.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/mcp/eglc.test.ts` Expected: PASS.

- [ ] **Step 6: Config and wiring**

Create `mcp.config.ts`:

```ts
// The MCP servers every conversation can use (see src/mcp.ts). Headers holding secrets read them from the environment.
import type { McpServerConfig } from "./src/mcp.ts";
import { eglcTransform } from "./src/mcp/eglc.ts";

export const mcpServers: readonly McpServerConfig[] = [
  {
    // El Gato y La Caja's search over its books, notes and newsletters. Streamable HTTP; its card lists only /sse.
    name: "eglc",
    url: "https://search.elgatoylacaja.com/mcp",
    transform: eglcTransform,
  },
];
```

In `server.ts`, `import { mcpServers } from "./mcp.config.ts";` and add `mcp: mcpServers,` to the `Agents.layer({...})` options. In `index.ts`, add `mcp: mcpServers` to both `Agents.layer({...})` calls (the configured-model one and the faux one).

Check `tsconfig.json` `include` covers `mcp.config.ts` at the root (it already covers `server.ts`/`index.ts`); add it if not.

- [ ] **Step 7: Integration test and script**

`vitest.config.ts` becomes:

```ts
import { configDefaults, defineConfig } from "vitest/config";

// Docker tests (`*.docker.test.ts`) run only through `pnpm test:docker` (DOCKER_TESTS) and tests against real network
// services (`*.integration.test.ts`) only through `pnpm test:integration` (INTEGRATION_TESTS), so the git hooks stay
// fast and work offline.
const docker = process.env.DOCKER_TESTS === "1";
const integration = process.env.INTEGRATION_TESTS === "1";
const special = ["src/**/*.docker.test.ts", "src/**/*.integration.test.ts"];

const include = () => {
  if (docker) {
    return ["src/**/*.docker.test.ts"];
  }
  if (integration) {
    return ["src/**/*.integration.test.ts"];
  }
  return ["src/**/*.test.ts"];
};

export default defineConfig({
  test: {
    include: include(),
    exclude:
      docker || integration
        ? configDefaults.exclude
        : [...configDefaults.exclude, ...special],
  },
});
```

In `package.json` scripts, after `test:docker`: `"test:integration": "INTEGRATION_TESTS=1 vitest run",`.

Create `src/mcp.eglc.integration.test.ts`:

```ts
// Against the real El Gato y La Caja server: `pnpm test:integration`.
import { describe, expect, it } from "vitest";

import { mcpServers } from "../mcp.config.ts";
import { connectMcpServers } from "./mcp.ts";

describe("eglc MCP server", () => {
  it("connects, searches and returns a trimmed post", async () => {
    const connections = await connectMcpServers(
      mcpServers.filter((s) => s.name === "eglc")
    );
    try {
      const [server] = connections.servers;
      expect(server?.status).toBe("connected");
      expect(server?.tools.map((t) => t.name).toSorted()).toStrictEqual([
        "get_recommendations",
        "get_wordpress_post",
        "list_projects",
        "search",
      ]);
      const tool = (name: string) => {
        const found = connections.extension?.tools?.find(
          (t) => t.name === name
        );
        if (found === undefined) {
          throw new Error(`no tool ${name}`);
        }
        return (args: Record<string, unknown>) =>
          found.execute(args as never, {} as never, {} as never);
      };
      const search = await tool("mcp_eglc_search")({
        query: "sueño",
        doc_type: "post",
        limit: 2,
      });
      expect(JSON.stringify(search.content)).toContain("results");
      const post = await tool("mcp_eglc_get_wordpress_post")({
        permalink: "la-ciencia-del-sueno",
      });
      const text =
        post.content
          ?.flatMap((c) => (c.type === "text" ? [c.text] : []))
          .join("") ?? "";
      expect(text.length).toBeLessThan(12_000);
      expect(text).toContain('"id_post":870');
    } finally {
      await connections.close();
    }
  }, 30_000);
});
```

- [ ] **Step 8: Run**

Run: `pnpm test && pnpm test:integration` Expected: `pnpm test` passes and does not run the integration test; `pnpm test:integration` passes (needs network).

- [ ] **Step 9: Commit**

```bash
pnpm check
git add mcp.config.ts src/mcp/eglc.ts src/mcp/eglc.test.ts src/testing/fixtures/eglc-post.json src/mcp.eglc.integration.test.ts vitest.config.ts package.json server.ts index.ts tsconfig.json
git commit -m "Connect El Gato y La Caja's search MCP and trim its posts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Drop `tsconfig.json` from `git add` if it did not change.)

---

### Task 4: `/skill:` on the server, tagged format, `GET /api/capabilities`

**Files:**

- Modify: `src/skills.ts:255-285` (expansion)
- Modify: `src/errors.ts` (`SkillNotFound`)
- Modify: `src/agents.ts` (`expandSkill`)
- Modify: `src/server/conversations.ts` (`create`, `send`, service type)
- Modify: `src/server/api.ts`, `src/server/handlers.ts`
- Modify: `index.ts` (CLI keeps `expandSkillCommand`)
- Test: `src/skills.test.ts:121-137`, `src/server/server.test.ts`

**Interfaces:**

- Consumes: `Agents.capabilities` (Task 2).
- Produces:

  ```ts
  // src/skills.ts
  export const parseSkillCommand: (prompt: string) => { readonly name: string; readonly request: string } | undefined;
  export const formatSkillMessage: (skill: Skill, request: string) => string;
  export const expandSkillCommand: (prompt: string, skills: readonly Skill[]) => string; // throws on unknown skill
  // src/errors.ts
  export class SkillNotFound /* { name: string; available: readonly string[] } */
  // Agents service gains:
  expandSkill(prompt: string): Effect.Effect<string, SkillNotFound>;
  // API: GET /api/capabilities -> Capabilities (Task 2 shape); create/send error SkillNotFound with status 400
  ```

- [ ] **Step 1: Update the skills test to the tagged format (failing)**

Replace the body of the `describe(expandSkillCommand, ...)` test in `src/skills.test.ts`:

```ts
it("wraps the skill's instructions in a skill tag, followed by the request", () => {
  const { skills } = loadSkills(
    skillsDir({ "convert/SKILL.md": skillFile("convert", "Convert units.") })
  );

  const expanded = expandSkillCommand("/skill:convert 3 mi to km", skills);

  expect(expanded).toMatch(
    /^<skill name="convert">\nSkill "convert"\. It has no bundled files\./u
  );
  expect(expanded).toMatch(/Do the thing\.\n<\/skill>\n\n3 mi to km$/u);
  expect(expandSkillCommand("/skill:convert", skills)).toMatch(
    /Do the thing\.\n<\/skill>$/u
  );
  expect(expandSkillCommand("3 mi to km", skills)).toBe("3 mi to km");
  expect(() => expandSkillCommand("/skill:nope x", skills)).toThrow(
    "No skill named nope"
  );
});
```

If `skillFile`'s body ends with a newline, `readSkill` output ends with `\n`; `formatSkillMessage` trims trailing whitespace of the instructions before `\n</skill>`, which the regex above assumes.

- [ ] **Step 2: Write the failing server tests**

Add to `src/server/server.test.ts` (inside `describe("HTTP API", ...)`), with imports `loadSkills` from `../skills.ts` and `fakeMcpServer` from `../testing/mcp.ts`:

```ts
it("lists skills and MCP servers", async () => {
  const { skills } = loadSkills("skills");
  const capabilities = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api);
      return yield* client.info.capabilities();
    }).pipe(
      Effect.provide(
        serverWith(
          fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
            skills,
            mcp: [
              fakeMcpServer("test", [
                { name: "echo", call: () => ({ content: [] }) },
              ]),
            ],
          }).layer
        )
      )
    )
  );
  expect(capabilities.skills.map((s) => s.name)).toContain("unit-conversion");
  expect(capabilities.mcp).toStrictEqual([
    {
      name: "test",
      url: "memory://test",
      status: "connected",
      tools: [{ name: "echo", description: "" }],
    },
  ]);
});

it("expands /skill: on create and send, and refuses unknown skills", async () => {
  const { skills } = loadSkills("skills");
  const agents = fauxAgents(
    [
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
    ],
    { skills }
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api);
      const created = yield* client.conversations.create({
        payload: {
          sandbox: "none",
          prompt: "/skill:unit-conversion 3 mi to km",
        },
      });
      const unknown = yield* Effect.flip(
        client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "/skill:nope hi" },
        })
      );
      const events = yield* client.conversations.events({
        params: { id: created.id },
      });
      const snapshot = yield* events.pipe(Stream.runHead);
      return { created, unknown, snapshot };
    }).pipe(Effect.provide(serverWith(agents.layer)))
  );
  expect(result.created.title).toBe("/skill:unit-conversion 3 mi to km");
  expect(result.unknown._tag).toBe("SkillNotFound");
  const snapshot = JSON.stringify(result.snapshot);
  expect(snapshot).toContain('<skill name=\\"unit-conversion\\">');
  expect(snapshot).toContain("3 mi to km");
  expect(snapshot).not.toContain("/skill:nope");
  // The rejected send queued nothing: only the first prompt reached the model.
  expect(agents.faux.state.callCount).toBe(1);
});
```

The first run may still be in progress when the snapshot is read; if the snapshot does not yet hold the user entry, wait for `run_end` the way the existing "creates a conversation and streams its events over SSE" test does (`Stream.takeUntil` on `run_end`), then assert on the collected events.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/skills.test.ts src/server/server.test.ts` Expected: FAIL (old expansion format; `client.info.capabilities` does not exist).

- [ ] **Step 4: Implement the expansion in `src/skills.ts`**

Replace `expandSkillCommand` with:

```ts
/** `/skill:<name> <request>`: the skill's name and the request (possibly empty); `undefined` for any other prompt. */
export const parseSkillCommand = (
  prompt: string
): { readonly name: string; readonly request: string } | undefined => {
  const match =
    /^\/skill:(?<name>[a-z0-9-]+)(?:\s+(?<request>[\s\S]*))?$/u.exec(
      prompt.trim()
    );
  if (match?.groups === undefined) {
    return;
  }
  return {
    name: match.groups.name as string,
    request: (match.groups.request ?? "").trim(),
  };
};

/**
 * The message a forced skill becomes: its instructions in a `<skill name="…">` block, then the request. The web
 * console recognizes the block and shows it as a chip (`web/lib/skill-message.ts`).
 */
export const formatSkillMessage = (skill: Skill, request: string): string => {
  const block = `<skill name="${skill.name}">\n${readSkill(skill).trimEnd()}\n</skill>`;
  return request === "" ? block : `${block}\n\n${request}`;
};

/** `/skill:<name> <request>` forces that skill (see `formatSkillMessage`); any other prompt is returned as is. */
export const expandSkillCommand = (
  prompt: string,
  skills: readonly Skill[]
): string => {
  const command = parseSkillCommand(prompt);
  if (command === undefined) {
    return prompt;
  }
  const skill = skills.find((s) => s.name === command.name);
  if (skill === undefined) {
    throw new Error(
      `No skill named ${command.name}. Skills: ${skills.map((s) => s.name).join(", ")}`
    );
  }
  return formatSkillMessage(skill, command.request);
};
```

- [ ] **Step 5: `SkillNotFound` and `Agents.expandSkill`**

Append to `src/errors.ts`:

```ts
export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()(
  "SkillNotFound",
  { name: Schema.String, available: Schema.Array(Schema.String) }
) {}
```

In `src/agents.ts`: import `SkillNotFound` from `./errors.ts` and `formatSkillMessage, parseSkillCommand` from `./skills.ts`. Add to the service interface:

```ts
    /** Expand `/skill:<name> <request>` into the skill message; other prompts pass through. */
    expandSkill(prompt: string): Effect.Effect<string, SkillNotFound>;
```

and before `return Agents.of({`:

```ts
const expandSkill = (prompt: string) =>
  Effect.suspend(() => {
    const command = parseSkillCommand(prompt);
    if (command === undefined) {
      return Effect.succeed(prompt);
    }
    const skill = skills.find((s) => s.name === command.name);
    return skill === undefined
      ? Effect.fail(
          new SkillNotFound({
            name: command.name,
            available: skills.map((s) => s.name),
          })
        )
      : Effect.sync(() => formatSkillMessage(skill, command.request));
  });
```

Add `expandSkill` to `Agents.of({...})`.

- [ ] **Step 6: Expand in `Conversations`**

In `src/server/conversations.ts`:

- import `SkillNotFound` as a type from `../errors.ts`;
- add `| SkillNotFound` to the error unions of `create` and `send` in the service interface;
- in `create`, before `Effect.uninterruptibleMask`: `const prompt = yield* agents.expandSkill(input.prompt);` and change `sendLive(id, created, input.prompt)` to `sendLive(id, created, prompt)`. `titleOf(input.prompt)` stays (the title is the prompt as typed);
- in `send`, first line: `const expanded = yield* agents.expandSkill(prompt);` and pass `expanded` to both `sendLive` calls.

Expansion runs before any sandbox is reserved, so an unknown skill creates nothing.

- [ ] **Step 7: API and handlers**

In `src/server/api.ts`: import and re-export `SkillNotFound`; add a `Capabilities` schema and the endpoint:

```ts
export const Capabilities = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      modelInvocable: Schema.Boolean,
    })
  ),
  mcp: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      status: Schema.Literals(["connected", "unavailable"]),
      error: Schema.optionalKey(Schema.String),
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, description: Schema.String })
      ),
    })
  ),
});
export type Capabilities = typeof Capabilities.Type;
```

- `create` error becomes `[SandboxLimitReached.pipe(HttpApiSchema.status(409)), SkillNotFound.pipe(HttpApiSchema.status(400))]`.
- `send` error becomes `[NotFound, ConversationEnded.pipe(HttpApiSchema.status(409)), SkillNotFound.pipe(HttpApiSchema.status(400))]`.
- The `info` group gains `HttpApiEndpoint.get("capabilities", "/capabilities", { success: Capabilities })`.

In `src/server/handlers.ts`, `infoHandlers` needs `Agents`:

```ts
const infoHandlers = (info: { readonly model: string }) =>
  HttpApiBuilder.group(
    Api,
    "info",
    Effect.fnUntraced(function* (handlers) {
      const agents = yield* Agents;
      return handlers
        .handle("get", () => Effect.succeed(info))
        .handle("capabilities", () => agents.capabilities);
    })
  );
```

(import `Agents` from `../agents.ts`). `Conversations.layer` already requires `Agents`; if the server layer does not expose `Agents` to the handlers, change `Conversations.layer`'s composition in `server.ts` and in `src/server/server.test.ts` `serverWith` to `Layer.provideMerge(agents)` instead of `Layer.provide(agents)` so the handlers see it.

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run src/skills.test.ts src/server/server.test.ts && pnpm test` Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm check
git add src/skills.ts src/skills.test.ts src/errors.ts src/agents.ts src/server/conversations.ts src/server/api.ts src/server/handlers.ts src/server/server.test.ts server.ts index.ts
git commit -m "Expand /skill: on the server and serve the capabilities

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Skill chip in the transcript

**Files:**

- Create: `web/lib/skill-message.ts`
- Test: `web/lib/skill-message.test.ts`
- Modify: `web/components/console/transcript.tsx:156-172`

**Interfaces:**

- Produces:

  ```ts
  export interface SkillMessage { readonly skill: string; readonly instructions: string; readonly request: string }
  export const parseSkillMessage: (text: string) => SkillMessage | undefined;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { parseSkillMessage } from "./skill-message";

describe(parseSkillMessage, () => {
  it("splits the skill block from the request", () => {
    expect(
      parseSkillMessage(
        '<skill name="repo-report">\n# Report\nDo it.\n</skill>\n\nreport this repo'
      )
    ).toStrictEqual({
      skill: "repo-report",
      instructions: "# Report\nDo it.",
      request: "report this repo",
    });
  });

  it("accepts a block with no request", () => {
    expect(parseSkillMessage('<skill name="x">\nbody\n</skill>')).toStrictEqual(
      {
        skill: "x",
        instructions: "body",
        request: "",
      }
    );
  });

  it("keeps a closing tag inside the instructions", () => {
    const text =
      '<skill name="x">\nWrite </skill> literally:\n</skill>\n\nnot the end\n</skill>\n\nreal request';
    expect(parseSkillMessage(text)).toStrictEqual({
      skill: "x",
      instructions: "Write </skill> literally:\n</skill>\n\nnot the end",
      request: "real request",
    });
  });

  it("ignores ordinary messages", () => {
    expect(parseSkillMessage("hello")).toBeUndefined();
    expect(
      parseSkillMessage('say <skill name="x">\nhi\n</skill>')
    ).toBeUndefined();
    expect(parseSkillMessage('<skill name="x">\nunterminated')).toBeUndefined();
  });
});
```

Note on the third case: the request is whatever follows the **last** `\n</skill>` that is followed by end of text or `\n\n`. A request that itself contains `\n</skill>\n\n` would be misread; that is accepted (the console never produces it).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter web exec vitest run lib/skill-message.test.ts` Expected: FAIL, cannot resolve `./skill-message`.

- [ ] **Step 3: Implement `web/lib/skill-message.ts`**

```ts
// A forced skill reaches the model as `<skill name="…">\n…\n</skill>` then the request (src/skills.ts
// formatSkillMessage); the transcript shows it as a chip and the request.

export interface SkillMessage {
  readonly skill: string;
  readonly instructions: string;
  readonly request: string;
}

const OPEN = /^<skill name="(?<name>[a-z0-9-]+)">\n/u;
const CLOSE = "\n</skill>";

export const parseSkillMessage = (text: string): SkillMessage | undefined => {
  const open = OPEN.exec(text);
  if (open?.groups === undefined) {
    return;
  }
  const body = text.slice(open[0].length);
  // The last closing tag that ends the text or is followed by a blank line ends the block.
  for (
    let at = body.lastIndexOf(CLOSE);
    at !== -1;
    at = body.lastIndexOf(CLOSE, at - 1)
  ) {
    const rest = body.slice(at + CLOSE.length);
    if (rest === "" || rest.startsWith("\n\n")) {
      return {
        skill: open.groups.name as string,
        instructions: body.slice(0, at),
        request: rest.slice(2).trim(),
      };
    }
    if (at === 0) {
      break;
    }
  }
  return;
};
```

With the third test, the last valid `\n</skill>` is the one before `\n\nreal request`, so the instructions keep the inner tags. Verify the test passes; if the loop's `at - 1` start skips a match at position 0, keep the `at === 0` guard as written.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter web exec vitest run lib/skill-message.test.ts` Expected: PASS.

- [ ] **Step 5: Render the chip**

In `web/components/console/transcript.tsx`, import `parseSkillMessage` from `@/lib/skill-message`, `Markdown` from `./markdown` (already imported if used for assistant text; check), and `BookOpen` from `lucide-react`. In the `case "user":` branch, replace the text paragraph:

```tsx
    case "user": {
      const { text, images } = userParts(message);
      const skill = parseSkillMessage(text);
      const shown = skill === undefined ? text : skill.request;
      return (
        <div className="bg-muted text-foreground ml-auto flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5">
          {skill === undefined ? null : (
            <details className="group">
              <summary className="text-muted-foreground inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium">
                <BookOpen aria-hidden className="size-3.5" />
                skill: {skill.skill}
              </summary>
              <div className="border-border mt-2 border-l-2 pl-3 text-sm">
                <Markdown>{skill.instructions}</Markdown>
              </div>
            </details>
          )}
          {shown === "" ? null : (
            <p className="text-prose break-words whitespace-pre-wrap">{shown}</p>
          )}
          {images.map((image) => (
            // oxlint-disable-next-line next/no-img-element -- inline data URL, nothing for next/image to optimize
            <img
              key={image.src}
              src={image.src}
              alt="Attachment"
              className="max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          ))}
        </div>
      );
    }
```

`web/lib/export.ts` is unchanged, so exports keep the full text.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add web/lib/skill-message.ts web/lib/skill-message.test.ts web/components/console/transcript.tsx
git commit -m "Show a forced skill as a chip in the transcript

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Capabilities sheet

**Files:**

- Create: `web/lib/draft.ts`
- Test: `web/lib/draft.test.ts`
- Modify: `web/lib/queries.ts` (`useCapabilities`)
- Create: `web/components/console/capabilities-sheet.tsx`
- Modify: `web/components/console/sidebar.tsx` (footer)
- Modify: `web/components/console/message-input.tsx`, `web/components/console/new-conversation.tsx` (take drafts)

**Interfaces:**

- Consumes: `GET /api/capabilities` (`client.info.capabilities()`, type `Capabilities` exported from `effect-pi/api`) from Task 4.
- Produces:

  ```ts
  // web/lib/draft.ts
  export const useDraft: UseBoundStore<StoreApi<{ readonly draft: string | undefined; offer(text: string): void; take(): string | undefined }>>;
  // web/lib/queries.ts
  export const useCapabilities: () => UseQueryResult<Capabilities>;
  ```

- [ ] **Step 1: Write the failing draft test**

`web/lib/draft.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { useDraft } from "./draft";

describe("useDraft", () => {
  beforeEach(() => useDraft.setState({ draft: undefined }));

  it("hands an offered draft to one taker", () => {
    useDraft.getState().offer("/skill:repo-report ");
    expect(useDraft.getState().draft).toBe("/skill:repo-report ");
    expect(useDraft.getState().take()).toBe("/skill:repo-report ");
    expect(useDraft.getState().take()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter web exec vitest run lib/draft.test.ts` Expected: FAIL, cannot resolve `./draft`.

- [ ] **Step 3: Implement `web/lib/draft.ts`**

```ts
// Text to put in whichever composer is on screen, such as `/skill:<name> ` chosen in the capabilities sheet. The
// mounted composer takes it once.
import { create } from "zustand";

interface Draft {
  readonly draft: string | undefined;
  offer(text: string): void;
  take(): string | undefined;
}

export const useDraft = create<Draft>()((set, get) => ({
  draft: undefined,
  offer: (text) => set({ draft: text }),
  take: () => {
    const { draft } = get();
    set({ draft: undefined });
    return draft;
  },
}));
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter web exec vitest run lib/draft.test.ts` Expected: PASS.

- [ ] **Step 5: Query, sheet, sidebar, composers**

`web/lib/queries.ts`, after `useInfo`:

```ts
export const useCapabilities = () =>
  useQuery({
    queryKey: ["capabilities"],
    queryFn: () => runApi((c) => c.info.capabilities()),
    // MCP servers connect once, at server start; a restart reloads the page's data anyway.
    staleTime: Number.POSITIVE_INFINITY,
  });
```

`web/components/console/capabilities-sheet.tsx`:

```tsx
"use client";

import { BookOpen, ChevronRight, Plug } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useDraft } from "@/lib/draft";
import { useCapabilities } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const CapabilitiesSheet = () => {
  const [open, setOpen] = useState(false);
  const { data } = useCapabilities();
  const offer = useDraft((store) => store.offer);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => setOpen(true)}
      >
        <Plug />
        Capabilities
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Capabilities</SheetTitle>
            <SheetDescription>
              Skills and MCP servers every conversation can use.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-6 px-4 pb-6">
              <section
                aria-labelledby="skills-heading"
                className="flex flex-col gap-2"
              >
                <h3
                  id="skills-heading"
                  className="font-heading text-sm font-semibold"
                >
                  Skills
                </h3>
                {data?.skills.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No skills installed.
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {data?.skills.map((skill) => (
                    <li key={skill.name}>
                      <button
                        type="button"
                        onClick={() => {
                          offer(`/skill:${skill.name} `);
                          setOpen(false);
                        }}
                        className="hover:bg-muted focus-visible:ring-ring/50 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2"
                      >
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <BookOpen
                            aria-hidden
                            className="text-muted-foreground size-3.5"
                          />
                          {skill.name}
                          {skill.modelInvocable ? null : (
                            <span className="text-muted-foreground text-xs font-normal">
                              · command only
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {skill.description}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section
                aria-labelledby="mcp-heading"
                className="flex flex-col gap-2"
              >
                <h3
                  id="mcp-heading"
                  className="font-heading text-sm font-semibold"
                >
                  MCP servers
                </h3>
                {data?.mcp.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No MCP servers configured.
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {data?.mcp.map((server) => (
                    <li key={server.name}>
                      <Collapsible>
                        <CollapsibleTrigger className="hover:bg-muted focus-visible:ring-ring/50 group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2">
                          <ChevronRight
                            aria-hidden
                            className="text-muted-foreground size-3.5 transition-transform group-data-[panel-open]:rotate-90"
                          />
                          <span
                            aria-hidden
                            className={cn(
                              "size-2 rounded-full",
                              server.status === "connected"
                                ? "bg-success"
                                : "bg-destructive"
                            )}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">
                              {server.name}
                              <span className="sr-only">
                                {server.status === "connected"
                                  ? ", connected"
                                  : ", unavailable"}
                              </span>
                            </span>
                            <span
                              className="text-muted-foreground truncate font-mono text-xs"
                              title={server.url}
                            >
                              {server.url}
                            </span>
                          </span>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pl-9">
                          {server.error === undefined ? null : (
                            <p className="text-destructive py-1 text-xs">
                              {server.error}
                            </p>
                          )}
                          <ul className="flex flex-col gap-1.5 py-1">
                            {server.tools.map((tool) => (
                              <li
                                key={tool.name}
                                className="flex flex-col gap-0.5"
                              >
                                <span className="font-mono text-xs">
                                  {tool.name}
                                </span>
                                {tool.description === "" ? null : (
                                  <span className="text-muted-foreground text-xs">
                                    {tool.description}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </CollapsibleContent>
                      </Collapsible>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
};
```

Before writing it, check `web/components/ui/collapsible.tsx` for its export names and the open-state data attribute (base-ui uses `data-panel-open` on the trigger), and `web/app/globals.css` for a success color token (`--success`; if absent, use `bg-emerald-500`). Use what exists.

`web/components/console/sidebar.tsx`: import `CapabilitiesSheet` from `./capabilities-sheet` and add `<CapabilitiesSheet />` as the first child of the footer `div` (before the model name `span`).

`web/components/console/message-input.tsx` and `new-conversation.tsx`: take drafts. Add to each component (with `useEffect` imported from react and `useDraft` from `@/lib/draft`):

```tsx
const draft = useDraft((store) => store.draft);
useEffect(() => {
  if (draft === undefined) {
    return;
  }
  const text = useDraft.getState().take();
  if (text !== undefined) {
    setPrompt(text);
  }
}, [draft]);
```

Only one of them is mounted at a time (`web/app/page.tsx` shows the new-conversation form or a conversation), so one composer takes the draft.

- [ ] **Step 6: Check by hand**

Run: `pnpm dev`, open `http://localhost:3001`, click "Capabilities" in the sidebar. Expected: the sheet lists the three skills and `eglc` (connected) with its four tools; clicking a skill closes the sheet and puts `/skill:<name> ` in the composer.

- [ ] **Step 7: Check and commit**

```bash
pnpm check
git add web/lib/draft.ts web/lib/draft.test.ts web/lib/queries.ts web/components/console/capabilities-sheet.tsx web/components/console/sidebar.tsx web/components/console/message-input.tsx web/components/console/new-conversation.tsx
git commit -m "List skills and MCP servers in a capabilities sheet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `/` autocomplete in the composer

**Files:**

- Create: `web/lib/skill-autocomplete.ts`
- Test: `web/lib/skill-autocomplete.test.ts`
- Modify: `web/components/console/composer.tsx`
- Modify: `web/lib/api.ts` (`apiError` for `SkillNotFound`)
- Test: `web/lib/api.test.ts` (create if absent)

**Interfaces:**

- Consumes: `useCapabilities` (Task 6).
- Produces:

  ```ts
  export interface SkillOption { readonly name: string; readonly description: string }
  export const skillQuery: (prompt: string) => string | undefined;
  export const matchSkills: (skills: readonly SkillOption[], query: string) => readonly SkillOption[];
  export const completeSkill: (name: string) => string;
  export const moveSelection: (index: number, delta: 1 | -1, length: number) => number;
  ```

- [ ] **Step 1: Write the failing tests**

`web/lib/skill-autocomplete.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  completeSkill,
  matchSkills,
  moveSelection,
  skillQuery,
} from "./skill-autocomplete";

const skills = [
  { name: "unit-conversion", description: "Convert units" },
  { name: "repo-report", description: "Report on a repo" },
  { name: "desktop-notes", description: "Notes on the desktop" },
];

describe(skillQuery, () => {
  it("reads the query while the prompt is a bare slash command", () => {
    expect(skillQuery("/")).toBe("");
    expect(skillQuery("/rep")).toBe("rep");
    expect(skillQuery("/skill:")).toBe("");
    expect(skillQuery("/skill:rep")).toBe("rep");
  });

  it("closes once there is whitespace or no leading slash", () => {
    expect(skillQuery("/skill:repo-report ")).toBeUndefined();
    expect(skillQuery("hello /rep")).toBeUndefined();
    expect(skillQuery("")).toBeUndefined();
  });
});

describe(matchSkills, () => {
  it("prefix-matches names, sorted", () => {
    expect(matchSkills(skills, "").map((s) => s.name)).toStrictEqual([
      "desktop-notes",
      "repo-report",
      "unit-conversion",
    ]);
    expect(matchSkills(skills, "re").map((s) => s.name)).toStrictEqual([
      "repo-report",
    ]);
    expect(matchSkills(skills, "zzz")).toStrictEqual([]);
  });

  it("also matches the 'skill:' prefix typed as part of the query", () => {
    expect(matchSkills(skills, "sk").map((s) => s.name)).toStrictEqual([
      "desktop-notes",
      "repo-report",
      "unit-conversion",
    ]);
  });
});

describe(completeSkill, () => {
  it("completes to the command with a trailing space", () => {
    expect(completeSkill("repo-report")).toBe("/skill:repo-report ");
  });
});

describe(moveSelection, () => {
  it("wraps around", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
```

Matching rule for `"sk"`: `"/sk"` is a prefix of `"/skill:"`, so all skills match (the user is typing the command name).

Add to `web/lib/api.test.ts` (create with the imports if the file does not exist):

```ts
import { describe, expect, it } from "vitest";

import { apiError } from "./api";

describe(apiError, () => {
  it("explains an unknown skill and lists the available ones", () => {
    expect(
      apiError({ _tag: "SkillNotFound", name: "nope", available: ["a", "b"] })
    ).toBe("No skill named nope. Available: a, b.");
  });
});
```

`web/lib/api.ts` touches `window` only inside `makeClient` (lazy, in `Effect.suspend`), so importing it in a node test is fine; if the import fails, move `apiError` into `web/lib/api-error.ts` and re-export it from `api.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web exec vitest run lib/skill-autocomplete.test.ts lib/api.test.ts` Expected: FAIL (module missing; `apiError` returns `"SkillNotFound"`).

- [ ] **Step 3: Implement `web/lib/skill-autocomplete.ts`**

```ts
// The composer's `/` list: while the prompt is a slash command with no whitespace yet, offer the skills.

export interface SkillOption {
  readonly name: string;
  readonly description: string;
}

const COMMAND = "skill:";

/** What follows `/` (without a typed `skill:`), or `undefined` when the list should be closed. */
export const skillQuery = (prompt: string): string | undefined => {
  if (!prompt.startsWith("/") || /\s/u.test(prompt)) {
    return;
  }
  const typed = prompt.slice(1);
  return typed.startsWith(COMMAND) ? typed.slice(COMMAND.length) : typed;
};

/** Skills whose name starts with the query, or all of them while the query is a prefix of `skill:`. */
export const matchSkills = (
  skills: readonly SkillOption[],
  query: string
): readonly SkillOption[] => {
  const all = skills.toSorted((a, b) => a.name.localeCompare(b.name));
  if (query !== "" && COMMAND.startsWith(query)) {
    return all;
  }
  return all.filter((skill) => skill.name.startsWith(query));
};

export const completeSkill = (name: string): string => `/skill:${name} `;

export const moveSelection = (
  index: number,
  delta: 1 | -1,
  length: number
): number => (length === 0 ? 0 : (index + delta + length) % length);
```

In `web/lib/api.ts` `apiError`, add a case:

```ts
      case "SkillNotFound": {
        const name = "name" in error ? String(error.name) : "";
        const available =
          "available" in error && Array.isArray(error.available) ? error.available.join(", ") : "";
        return `No skill named ${name}. Available: ${available}.`;
      }
```

Check that the composers' `onError` already toasts via `apiError` (`message-input.tsx` uses `error.message`; `runApi` may already map failures through `apiError` — read `runApi` and, if it does not, make both composers call `toast.error(apiError(error))`). The prompt stays in the box on error because `setPrompt("")` only runs `onSuccess`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter web exec vitest run lib/skill-autocomplete.test.ts lib/api.test.ts` Expected: PASS.

- [ ] **Step 5: Wire the list into `Composer`**

In `web/components/console/composer.tsx`:

```tsx
"use client";

import { ArrowUp, BookOpen } from "lucide-react";
import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { Button } from "@/components/ui/button";
import { useCapabilities } from "@/lib/queries";
import {
  completeSkill,
  matchSkills,
  moveSelection,
  skillQuery,
} from "@/lib/skill-autocomplete";
import { shouldSubmit } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// props unchanged

export const Composer = ({/* props unchanged */}) => {
  const listId = useId();
  const { data } = useCapabilities();
  const [selected, setSelected] = useState(0);
  // The prompt the list was dismissed for (Esc); it reopens when the prompt changes.
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const query = skillQuery(prompt);
  const options =
    query === undefined || dismissed === prompt
      ? []
      : matchSkills(data?.skills ?? [], query);
  const open = options.length > 0;
  const active = Math.min(selected, Math.max(options.length - 1, 0));

  const complete = (name: string) => {
    onPrompt(completeSkill(name));
    setSelected(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(
          moveSelection(
            active,
            event.key === "ArrowDown" ? 1 : -1,
            options.length
          )
        );
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        complete((options[active] as { name: string }).name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(prompt);
        return;
      }
    }
    if (
      shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })
    ) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Skills"
            className="bg-popover text-popover-foreground absolute right-0 bottom-full left-0 z-10 mb-2 max-h-64 overflow-y-auto rounded-lg border p-1 shadow-md"
          >
            {options.map((option, index) => (
              <li
                key={option.name}
                id={`${listId}-${option.name}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  // Keep focus in the textarea.
                  event.preventDefault();
                  complete(option.name);
                }}
                onMouseEnter={() => setSelected(index)}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5",
                  index === active && "bg-accent text-accent-foreground"
                )}
              >
                <span className="flex items-center gap-1.5 font-mono text-sm">
                  <BookOpen
                    aria-hidden
                    className="text-muted-foreground size-3.5"
                  />
                  /skill:{option.name}
                </span>
                <span className="text-muted-foreground line-clamp-2 text-xs">
                  {option.description}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="bg-card focus-within:border-ring focus-within:ring-ring/50 flex items-end gap-2 rounded-xl border p-1.5 shadow-xs focus-within:ring-3">
          <textarea
            ref={inputRef}
            autoFocus
            aria-label="Message"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open
                ? `${listId}-${(options[active] as { name: string }).name}`
                : undefined
            }
            placeholder={placeholder}
            rows={tall ? 3 : 1}
            value={prompt}
            onChange={(event) => {
              onPrompt(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            className={cn(
              "placeholder:text-muted-foreground md:text-prose field-sizing-content max-h-44 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-base outline-none",
              tall ? "min-h-24" : "min-h-9"
            )}
          />
          {/* Button unchanged */}
        </div>
      </div>
      <p className="text-muted-foreground px-1 text-xs">{hint}</p>
    </div>
  );
};
```

Keep the existing props type and the `Button` exactly as they are; only the parts shown change. The placeholder hint can mention the command: in `message-input.tsx` and `new-conversation.tsx` leave hints as they are (no copy change required by the spec).

- [ ] **Step 6: Check by hand**

Run: `pnpm dev`, open `http://localhost:3001`. Expected, in both the new-conversation box and an open conversation's box: typing `/` lists the skills; `/rep` narrows to `repo-report`; Up/Down move; Enter or Tab completes to `/skill:repo-report `; Esc closes; with the list closed Enter sends. Sending `/skill:nope hi` shows "No skill named nope. Available: …" and keeps the text. Sending `/skill:unit-conversion 3 mi to km` shows a "skill: unit-conversion" chip and the request.

- [ ] **Step 7: Check and commit**

```bash
pnpm check
git add web/lib/skill-autocomplete.ts web/lib/skill-autocomplete.test.ts web/lib/api.ts web/lib/api.test.ts web/components/console/composer.tsx web/components/console/message-input.tsx web/components/console/new-conversation.tsx
git commit -m "Autocomplete /skill: in the composer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Drop files from `git add` that did not change.)

---

### Task 8: Docs

**Files:**

- Modify: `AGENTS.md`
- Modify: `skills/README.md`

- [ ] **Step 1: AGENTS.md**

- Under "Vendored Repositories → Pi", add `- \`@earendil-works/pi-mcp\` → @repos/pi/packages/mcp/`.
- Under "Commands", add: `- \`pnpm test:integration\` runs the \`*.integration.test.ts\` tests against real network services (the eglc MCP server); not part of \`pnpm check\` or the hooks`.
- Add a section after "Skills":

```markdown
## MCP

`mcp.config.ts` lists the remote MCP servers (Streamable HTTP only; pi-mcp has no legacy SSE transport). `Agents.layer({ mcp })` connects them when the layer is built (`src/mcp.ts`, 10s timeout each) and closes them on teardown.

- Each tool becomes `mcp_<server>_<tool>` in one `mcp` extension that every conversation selects; calls run on the host, so chat conversations have them. MCP `isError` results reach the model as failed calls. MCP tools are not gated by approvals.
- A server that fails to connect is logged and reported `unavailable`; there is no reconnect, restart the server.
- A server entry can `transform` results before the model sees them: `src/mcp/eglc.ts` trims El Gato y La Caja's `get_wordpress_post` (body three times as HTML plus WordPress metadata) to the article as text and its metadata, including `id_post`, the id `get_recommendations` takes.
- Tests use `fakeMcpServer` (`src/testing/mcp.ts`, pi-mcp's in-memory transport).
```

- In "Skills", change the `/skill:` line to: `` `/skill:<name> <request>` forces a skill, in the CLI and the web console (`expandSkillCommand`, `Agents.expandSkill`); the message becomes `<skill name="…">` + SKILL.md + `</skill>` + the request, which the console shows as a chip. An unknown skill is a 400 (`SkillNotFound`). `disable-model-invocation: true` hides a skill from the list. ``
- In "Web console", add a bullet: `` `GET /api/capabilities` lists skills and MCP servers; the sidebar's Capabilities sheet shows them, and clicking a skill puts `/skill:<name> ` in the composer (`web/lib/draft.ts`). `Composer` autocompletes `/skill:` (`web/lib/skill-autocomplete.ts`) in both text areas. ``

- [ ] **Step 2: skills/README.md**

Add a sentence where `/skill:` is explained: "In the web console, type `/` to pick a skill, or choose one in the sidebar's Capabilities sheet."

- [ ] **Step 3: Check and commit**

```bash
pnpm check
git add AGENTS.md skills/README.md
git commit -m "Document MCP servers, capabilities and /skill: in the console

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pnpm check` passes.
- [ ] `pnpm test:integration` passes (network).
- [ ] `pnpm dev`: in a chat conversation, ask "¿Qué publicó El Gato y La Caja sobre el sueño?" with a real model configured; the transcript shows `mcp_eglc_search` and an answer citing posts. With the echo model, the capabilities sheet and `/skill:` behave as in Tasks 6–7.
