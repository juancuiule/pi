// The MCP servers every conversation can use (see src/mcp.ts). Headers holding secrets read them from the environment.
import type { McpServerConfig } from "./src/mcp.ts";

export const mcpServers: readonly McpServerConfig[] = [];
