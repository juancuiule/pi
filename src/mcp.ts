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
  /**
   * Always defined, even with no tools: conversations record the extensions they select, so one created while every
   * server was down still selects `mcp` and gets its tools after a restart that reaches them.
   */
  readonly extension: Extension;
  close(): Promise<void>;
}

/** Providers accept at most 64 characters of `[A-Za-z0-9_-]` in a tool name. */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp_${server}_${tool}`
    .replaceAll(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, MAX_TOOL_NAME);

const withTimeout = async <A>(promise: Promise<A>, ms: number): Promise<A> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`timed out after ${ms}ms`));
  }, ms);
  try {
    return await Promise.race([promise, timeout.promise]);
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
      const raw = await server.client.callTool(
        tool.name,
        args,
        context.abortSignal === undefined ? {} : { signal: context.abortSignal }
      );
      const result = server.config.transform?.(tool.name, raw) ?? raw;
      // MCP reports tool failures in the result; the model sees them as a failed call.
      if (result.isError) {
        // oxlint-disable-next-line unicorn/prefer-type-error -- a failed tool call, not a type check
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
    extension: defineExtension({ name: "mcp", tools }),
    close: async () => {
      await Promise.all(
        connected.map((server) =>
          server.client.close().catch((): void => undefined)
        )
      );
    },
  };
};
