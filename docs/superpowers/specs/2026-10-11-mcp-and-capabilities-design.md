# MCP servers and capabilities in the console: design

Settled on 2026-10-11, after testing the El Gato y La Caja search MCP.

## Goal

Agents can use tools from remote MCP servers, starting with El Gato y La Caja's search (`eglc`). The web console shows which skills and MCP servers are available, and `/skill:<name>` works from its text areas as it does in the CLI.

Out of scope: a `/mcp:` command, MCP prompts and resources, OAuth, stdio servers, approvals for MCP tools.

## Background

- `https://search.elgatoylacaja.com` serves the same four tools over legacy HTTP+SSE (`/sse`, in its server card) and Streamable HTTP (`/mcp`), with no auth. `@earendil-works/pi-mcp` 1.1.0 (vendored at `repos/pi/packages/mcp/`) supports Streamable HTTP only, so we use `/mcp`.
- `get_wordpress_post` returns ~31k characters for a post with ~7k characters of text: the body three times as HTML, plus WordPress metadata. Search results lack the `wp_id` that `get_recommendations` needs; only the post response carries it (`id_post`).
- Today only the CLI expands `/skill:` (`index.ts`); the server sends it to the model verbatim.

## 1. MCP in the harness

**Config.** `mcp.config.ts` at the repository root exports the servers:

```ts
export interface McpServerConfig {
  readonly name: string; // [a-z0-9-]+, used in tool names
  readonly url: string; // Streamable HTTP endpoint
  readonly headers?: Record<string, string>; // read from env by the config itself
  /** Rewrite a tool's result before the model sees it. */
  readonly transform?: (tool: string, result: CallToolResult) => CallToolResult;
}
```

It starts with `eglc` → `https://search.elgatoylacaja.com/mcp` and its transform (below). `server.ts` and `index.ts` pass it to `Agents.layer({ mcp })`; tests pass their own.

**Connection** (`src/mcp.ts`). When the `Agents` layer is built, each server is connected with `McpClient` + `StreamableHttpTransport` and its tools listed; clients close when the layer is torn down. Connections happen in parallel with a 10s timeout each. A server that fails to connect or list is logged and recorded as unavailable with its error; startup continues and that server contributes no tools. There is no reconnect: a restart retries.

**Tools.** One `mcp` extension, selected by every conversation, registers each tool of each connected server:

- name `mcp_<server>_<tool>`, non `[A-Za-z0-9_-]` replaced by `_`, cut to 64 characters;
- description from the tool, prefixed with `[<server>]`;
- parameters: the tool's `inputSchema` forced to an object with `properties`;
- execute: `client.callTool(tool, args, { signal })`, then the server's `transform`, then `toLlmContent`; `isError: true` becomes a thrown error with the text content, so it reaches the model as a failed tool call.

Calls run on the host, so `none` conversations have the tools. Tracing and the console's tool cards need no changes. MCP tools are not gated by approvals.

**`eglc` transform.** For `get_wordpress_post`, the JSON text is replaced by `{ id_post, title, permalink, date, authors, tags, excerpt, content }`, where `content` is the post body converted once from HTML to plain text (paragraph breaks kept, tags dropped, entities decoded) and `authors` are names. Other tools pass through. A result that does not parse is passed through unchanged.

## 2. Showing capabilities

**API.** `GET /api/capabilities` (in `api.ts`, group `info`):

```ts
{
  skills: { name, description, modelInvocable }[],
  mcp: { name, url, status: "connected" | "unavailable", error?, tools: { name, description }[] }[]
}
```

`Agents` exposes a `capabilities` effect that builds it from the loaded skills and the MCP connection state.

**Console.** A "Capabilities" button in the sidebar footer opens a sheet with two sections:

- Skills: name and description; skills hidden from the model are marked "command only". Clicking one fills the active composer with `/skill:<name> ` and focuses it.
- MCP servers: name, URL and a status dot; unavailable servers show their error. Each expands to its tools with descriptions.

Data comes from a TanStack Query (`useCapabilities`), fetched once and kept (`staleTime: Infinity`).

## 3. `/skill:` from the console

**Server.** `Conversations.create` and `send` expand `/skill:<name> <request>` before submitting, through `Agents.expandSkill(prompt)`. An unknown skill fails with `SkillNotFound` (HTTP 400, listing the skills) and nothing is sent; other prompts pass through. The title of a created conversation is the prompt as typed.

The expansion changes to a tagged form, shared with the CLI:

```
<skill name="repo-report">
…SKILL.md…
</skill>

<request>
```

With no request, only the `<skill>` block is sent.

**Transcript.** A user message that starts with a `<skill name="…">…</skill>` block renders as a collapsed "skill: <name>" chip (expandable to the instructions as markdown) followed by the request. `parseSkillMessage` in `web/lib/` does the split. Markdown and JSON Lines exports keep the full text.

**Autocomplete.** `Composer`, used by both the new-conversation prompt and the message input, opens a list when the text starts with `/` and has no whitespace yet. It lists skills as `/skill:<name>` with their descriptions, filtered by what follows the `/` (prefix match, also matching the bare name, e.g. `/rep`). Up/Down move, Enter or Tab complete to `/skill:<name> `, Esc closes. Enter submits normally when the list is closed.

## Testing

- `src/mcp.test.ts`, with pi-mcp's in-memory transport and the faux model: a conversation calls an MCP tool and gets its result; `isError` reaches the model as an error; an unreachable server is unavailable and contributes no tools while others work; tool name sanitizing.
- `eglc` transform unit test with a recorded `get_wordpress_post` fixture: fields kept, content once as text, much smaller than the input.
- `src/mcp.eglc.integration.test.ts` against the real server (lists the four tools, a search returns results, the transformed post is under 12k characters). Excluded from `pnpm test` and `pnpm check`; run with `pnpm test:integration`.
- Server tests: `/capabilities` lists skills and MCP servers; `/skill:` on create and send expands; an unknown skill is 400 and nothing is submitted.
- Web unit tests: `parseSkillMessage`, autocomplete filtering and key handling logic (pure functions).

## Docs

AGENTS.md gains an "MCP" section (config, connection, naming, transform, integration test command) and notes the capabilities sheet and `/skill:` in the web console section. `skills/README.md` mentions the console.
