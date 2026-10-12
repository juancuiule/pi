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
    const answer = async (request: JsonRpcRequest) => {
      const reply = (result: unknown) =>
        pair.server.send({ jsonrpc: "2.0", id: request.id, result });
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
              content: [{ type: "text", text: `unknown tool ${params.name}` }],
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
    };
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
      queueMicrotask(async () => {
        try {
          await answer(request);
        } catch {
          // A reply to a closed client fails; the test that closed it has its answer already.
        }
      });
    });
    void pair.server.start();
    return pair.client;
  },
});
