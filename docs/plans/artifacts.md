# Artifacts

Sandboxed HTML pages the agent writes — reports, charts, dashboards, prototypes — shown beside the chat, the way Claude shows artifacts. Adapted from local-harness's ADR-0017 (`../local-harness/docs/adr/0017-html-artifacts.md`); what follows is that design mapped onto this codebase, minus its multi-user parts (the server has no auth and no other viewers, so there is no sharing or redaction).

## Lifecycle

```text
artifact_create(title, html) → artifacts row + version 1
artifact_update(id, html | edits, title?) → a new version (edits are exact find/replace pairs, unique in the page)
→ the tool result's details carry { id, version, title }
→ the console opens the page next to the chat: GET /api/artifacts/:id/render?v= in a sandboxed iframe
```

- **Storage.** Two tables in the `EFFECT_PI_DB` SQLite file, like the `attachments` table (`src/attachments/store.ts`): `artifacts` (id, conversation id, title, timestamps) and `artifact_versions` (artifact id, version, title, html, `call_id` unique — a replayed tool call finds its version instead of adding another). 300 KB per version. The HTML lives in a TEXT column; a `BlobStore` folder per artifact is the alternative if pages ever grow past it.
- **Scope.** An artifact belongs to one conversation, like a sent Attachment: it stays through Pause and Archive, and a delete endpoint removes it and its versions. An id outside its conversation is "not found".
- **Tools run on the host**, at every Level, and are not gated (a private page is not an external action): `artifact_create` and `artifact_update` (`edits` capped, e.g. 20 pairs). `api.callId` keys version idempotency; `replay: "unsafe"` stays. The result tells the model the person already sees the page — don't paste the HTML in the message.
- **Level none.** The tools work without a Sandbox, so a conversation with no machine can still produce a page. `workspaceSection("none")` must change so the model knows the boundary: something for the person to see or use → an artifact; files to keep or code to run → `upgrade_workspace` first.

## Rendering

- `GET /api/artifacts/:id/render?v=` returns the version's HTML with the sandboxing headers set on the response itself (like the attachment `original` handler, not a middleware): `content-security-policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`, plus `nosniff` and `no-store`.
- Vetted libraries come from `GET /api/artifact-libs/<file>`, an allowlist served from `node_modules` (Chart.js first, pinned in package.json); no CDNs — a page fetches nothing from the internet.
- The console embeds the page in `<iframe sandbox="allow-scripts">` and keeps local-harness's navigation guard: a page that navigates its own frame is reloaded once, then hidden (frame-src 'self' on the console's pages, added in `web/next.config.ts`, makes the browser refuse off-origin navigations).
- `GET /api/artifacts/:id/source?v=` returns `{ version, html }` for the panel's code tab; `GET /api/artifacts/:id` the view (title, versions); `GET /api/artifacts?conversation=` lists a conversation's; `DELETE /api/artifacts/:id` removes one.

## Console

- The transcript renders an `ArtifactCard` for `artifact_*` calls (branch where `ToolCall` is chosen, `transcript.tsx`): title, version, "open". The reference comes from the tool result's `details` — pi-durable's `api.details()` already reaches the console, which is how approvals and edit patches get through; no JSON-parsing the content text as local-harness does.
- A committed `artifact_*` tool result arriving over the event stream opens the panel on its own (same trigger as local-harness). The panel is a third `ResizablePanel` or a `Sheet`: the iframe, a version picker, a code tab, open-in-new-tab. A later `artifact_update` refetches the versions list while it is open.
- `toolSummary` (`title`) and `toolIcon` get artifact entries; the extension shows up in `/api/capabilities` like the others.

## Modules

- **`src/artifacts/`**: `store.ts` (the two tables on `DatabaseSync`, `local` and in-memory variants), `artifacts.ts` (the `Artifacts` service — `create`, `update`, `view`, `html`, `list`, `remove` — and the `artifacts` extension with its prompt section and the two tools, `Effect.runPromise` against the service like the attachment tools).
- **`src/server/`**: an `artifacts` group in `api.ts` (`ArtifactNotFound` at 404 in `errors.ts`), handlers in `handlers.ts`; `artifact-libs` there too.
- **`server.ts`**: `Artifacts.local({ database: config.paths.db })`, provided to `Agents.layer` and the API; `Artifacts.temporary()` in `fauxAgents`.
- **`src/agents/agents.ts`**: install `artifactsExtension(artifacts)` in the registry, in `installed`, in `everyLevel`, and probably `locked` like attachments.
- **`src/tracing.ts`**: `call.arguments` is traced verbatim — add `artifact_create`/`artifact_update` to the size-redacted set like attachment text, gated by the same flag (or a `TRACE_ARTIFACT_HTML`).

## Steps

1. `src/artifacts/store.ts` + `Artifacts` service, tested like `attachments`.
2. The extension (section + `artifact_create`/`artifact_update`), wired in `Agents.layer`; workspace section reworded.
3. API group + handlers + render CSP + `artifact-libs` (add `chart.js`).
4. Console: card, panel, auto-open, summary/icon; `frame-src 'self'` in `web/next.config.ts`.
5. Tracing redaction; GLOSSARY term ("Artifact: a sandboxed HTML page the agent writes…").

## Later

A gallery page and full-page route (local-harness's `/artifacts`, `/artifacts/[id]`), live iframe thumbnails, `.html` download or export to the Workspace, more vetted libraries, screenshot-on-render for thumbnails, per-artifact sharing if the server ever gains viewers.
