// Against the real El Gato y La Caja server: `pnpm test:integration`.
import { describe, expect, it } from "vitest";

import { mcpServers } from "../mcp.config.ts";
import { connectMcpServers } from "./mcp.ts";

describe("eglc MCP server", () => {
  it("connects, searches and returns a trimmed post", async () => {
    const connections = await connectMcpServers(
      mcpServers.filter((server) => server.name === "eglc")
    );
    try {
      expect(
        connections.servers[0]?.tools.map((tool) => tool.name).toSorted()
      ).toStrictEqual([
        "get_recommendations",
        "get_wordpress_post",
        "list_projects",
        "search",
      ]);
      const call = (name: string, args: Record<string, unknown>) => {
        const found = connections.extension.tools?.find((t) => t.name === name);
        if (found === undefined) {
          throw new Error(`no tool ${name}`);
        }
        return found.execute(args as never, {} as never, {} as never);
      };
      const search = await call("mcp_eglc_search", {
        query: "sueño",
        doc_type: "post",
        limit: 2,
      });
      expect(JSON.stringify(search.content)).toContain("results");
      const post = await call("mcp_eglc_get_wordpress_post", {
        permalink: "la-ciencia-del-sueno",
      });
      const text = (post.content ?? [])
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("");
      expect(text.length).toBeLessThan(12_000);
      expect(text).toContain('"id_post":870');
    } finally {
      await connections.close();
    }
  }, 30_000);
});
