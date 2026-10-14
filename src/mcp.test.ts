import { setTimeout as sleep } from "node:timers/promises";

import type { Extension } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { connectMcpServers, mcpToolName } from "./mcp.ts";
import { fakeMcpServer } from "./testing/mcp.ts";

/** Every MCP tool, across the servers' extensions. */
const toolsOf = (connections: { readonly extensions: readonly Extension[] }) =>
  connections.extensions.flatMap((extension) => extension.tools ?? []);

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

const executeOf = (
  connections: Awaited<ReturnType<typeof connectMcpServers>>,
  name: string
) => {
  const tool = toolsOf(connections).find((t) => t.name === name);
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
      const result = await executeOf(
        connections,
        "mcp_test_echo"
      )({
        text: "hi",
      });
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
      await expect(executeOf(connections, "mcp_test_fail")({})).rejects.toThrow(
        "it broke"
      );
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
      const result = await executeOf(connections, "mcp_t_echo")({});
      expect(result.content).toStrictEqual([{ type: "text", text: "shaped" }]);
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
      // One extension per server, the unavailable one too, so each can be switched off as a whole.
      expect(
        connections.extensions.map((extension) => [
          extension.name,
          (extension.tools ?? []).map((t) => t.name),
        ])
      ).toStrictEqual([
        ["mcp-down", []],
        ["mcp-test", ["mcp_test_echo", "mcp_test_fail"]],
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
    expect(toolsOf(connections)).toStrictEqual([]);
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
      expect(toolsOf(connections).map((t) => t.name)).toStrictEqual([
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
        call: (_args, signal) => {
          const stopped = Promise.withResolvers<ReturnType<typeof text>>();
          signal.addEventListener("abort", () => {
            aborted = true;
            stopped.resolve(text("stopped"));
          });
          return stopped.promise;
        },
      },
    ]);
    const connections = await connectMcpServers([slow]);
    try {
      const controller = new AbortController();
      const call = executeOf(connections, "mcp_s_wait")({}, controller.signal);
      await sleep(20);
      controller.abort(new Error("end"));
      await expect(call).rejects.toThrow("MCP request aborted");
      await sleep(20);
      expect(aborted).toBeTruthy();
    } finally {
      await connections.close();
    }
  });

  it("has an empty extension and nothing to close without servers", async () => {
    const connections = await connectMcpServers([]);
    expect(connections.servers).toStrictEqual([]);
    expect(toolsOf(connections)).toStrictEqual([]);
    await connections.close();
  });
});
