# Agent console: design

Settled in a grilling session on 2026-10-11.

## Goal

A local, single-user web UI to run several agent conversations at once, each with its own prompt and sandbox (`none` / `shell` / `desktop`), and watch every detail of each turn live.

## Decisions

1. Agents are the three sandbox kinds. Many conversations can run at the same time. Named profiles (system prompt + skills) can come later.
2. A separate long-running Effect HTTP server owns the harness and the sandboxes. Next.js is UI only.
3. The frontend is a `web/` package in the existing pnpm workspace.
4. The UI streams full event detail per turn. A pass that shows only meaningful text comes later.
5. Conversations persist in a SQLite file (`EFFECT_PI_DB`) and stay listed after "End", an idle timeout, or a restart. A sandbox does not survive any of those: a shell/desktop conversation is then `ended` (`sandbox_removed`), while a chat (`sandbox: "none"`) resumes on its next prompt. Work still running at startup is aborted.
6. Local only, no auth. The server binds to 127.0.0.1 and refuses any request whose `Host`, `Origin` or `X-Forwarded-Host` is not loopback (`src/server/loopback.ts`), so other websites cannot drive it from the browser.
7. The model comes from the environment (`src/models.ts`), and the UI shows which one. Without one, the server uses a faux echo model.
8. Transport: SSE `GET /api/conversations/:id/events` for events, `POST` for prompts.
9. The wire format is pi-durable's `AgentEvent` (from `watchEvents`) as-is: a `snapshot` event, then events per commit. Each SSE message carries one event.
10. A prompt sent while the agent runs is queued as a `followUp`. A steer toggle comes later.
11. A subagent shows as a collapsible nested stream under its tool call. The `subagent` tool reports `details: { conversationId }`, and the UI subscribes to that conversation's events.
12. Desktop: a noVNC iframe in a right panel, view-only by default with a "take control" toggle. Screenshots also show inline in tool results.
13. Ports: server `:4000`, Next `:3001` (Langfuse has `:3000`). Next rewrites `/api/*` to `:4000`. Root `pnpm dev` runs both.
14. Faux model fallback when no model is configured.
15. Tests: server integration tests through `HttpApiClient` against the real server layer (faux model, local sandboxes), in `pnpm check`. Web: typecheck, lint, and unit tests of the event reducer.
16. HTTP API:
    - `GET /api/conversations` lists root conversations, live and stored (id, sandbox, sandboxId, vncUrl, title, status, endedReason, pendingApprovals, createdAt).
    - `POST /api/conversations { sandbox, prompt, approvals? }` creates a conversation and sends the first prompt.
    - `POST /api/conversations/:id/messages { prompt }` sends a follow-up.
    - `GET /api/conversations/:id/events` is SSE: `snapshot`, then events. It also works for subagent conversations.
    - `DELETE /api/conversations/:id` ends the conversation and removes its sandbox; it stays listed as ended.
    - `POST /api/conversations/:id/approvals { key, decision }` approves, denies or "always" approves a gated tool call.
    - `GET /api/info` returns the model.
    - The title is the first prompt, truncated to 60 characters.
17. Schema-first `HttpApi` in `src/server/`, entry `server.ts` (`pnpm server`). `web/` imports the API definition from the root package (`effect-pi/api`) and derives a typed client.
18. `AgentConversation` gains `send(prompt)` (follow-up, no wait). `Agents` gains `events(id)`, a `Stream<AgentEvent>`. `ask` stays. A `Conversations` service owns one `Scope` per conversation (create, list, send, end, idle timeout, sandbox cap). Closing its layer removes every sandbox.
19. Web state: TanStack Query for REST. A Zustand store per conversation, filled from SSE by a pure `applyEvent(state, event)`.
20. Layout:
    - Sidebar: live conversations with a status dot, plus "New" (sandbox picker + prompt).
    - Main area: transcript (text, collapsible thinking, tool calls with arguments, streaming output and results, inline screenshots, nested subagents), with the input at the bottom.
    - Header: model, sandbox, usage, "End".
    - Right panel: noVNC (desktop) or a terminal (shell).
    - shadcn defaults, dark mode.
21. Sandbox cap: at most 3 live sandboxed conversations (configurable). Creating another fails with 409, and the UI shows it.
22. Zustand + TanStack Query. XState only if lifecycle logic grows.
23. The shell terminal panel is read-only xterm.js, replaying the agent's `bash` calls (`$ command` + streamed output). An interactive shell comes later.
24. The noVNC panel is view-only by default, with a "take control" toggle.

## Later

Cleaner event format, steer toggle, interactive shell (WebSocket + PTY), sandboxes that survive a restart, XState, Playwright.
