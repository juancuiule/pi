# Artifact pages fetch nothing; what the CSP would block is refused at write time

Artifacts are HTML pages the agent writes, so they are untrusted code shown next to the console. They render from `GET /api/artifacts/:id/render` with a strict CSP (inline scripts plus same-origin vetted libraries, no connections, frames or forms, images only from `data:`, `blob:`, same-origin or the person's Trusted domains) inside `<iframe sandbox="allow-scripts">`. `artifact_create` and `artifact_update` parse the page and refuse anything that CSP would block, naming the host: otherwise the page would ship silently broken and the model would never learn why. Adapted from local-harness's ADR-0017.

## Decisions

- **No CDNs.** Libraries come from an allowlist served from `node_modules` (`/api/artifact-libs/<file>`), pinned in `package.json`. A page cannot exfiltrate what it shows.
- **Trusted domains** are the one opening, for images, per User, edited by the person; the CSP and the prompt read the live list, so a domain added mid-conversation applies on the next call.
- **Ownership.** An artifact belongs to the root conversation of the tree that wrote it, so a parent lists and revises its subagents' pages. It stays through Pause and Archive, like a sent attachment.
- **Storage.** Versions are rows in `EFFECT_PI_DB` (300 KB each), idempotent by tool call id so a replayed call finds its version.
- Tools run on the host at every Level and are not gated by approvals: a private page is not an external action.

## Considered options

- Letting the page load anything and relying on the iframe sandbox: rejected because a sandboxed frame can still fetch, so it could send the conversation's data anywhere.
