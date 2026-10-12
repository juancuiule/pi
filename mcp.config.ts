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
