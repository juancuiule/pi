---
name: artifact-design
description: House style for artifact pages — the palette, type and layout that make a page look like it belongs to this product. Use whenever you build or update an artifact page, before writing its HTML.
---

# Artifact design

An artifact page lives in a panel beside the chat — usually a narrow column, not a full-width desktop. It is the deliverable: it should read complete without the conversation around it, and look like it belongs to this product.

## The sandbox you are in

- One self-contained HTML document, at most 300 KB: inline styles and scripts only. External anything is refused — no CDN, no fonts, no fetch.
- The only scripts you may load: `/api/artifact-libs/chart.umd.js` (the `Chart` global) and `/api/artifact-libs/pele.global.js` (pele, for mermaid-syntax diagrams — `pele.mount(el, source)`).
- All data is baked into the page; `connect-src` is none. Links cannot navigate — write sources and URLs out as text, never as the only way to reach them.
- `assets/base.html`, bundled with this skill, is the starter: copy it and fill in the page.

## Look

`assets/base.html` wires the console's own tokens as CSS variables. The short version:

- **Neutral first.** White background, near-black ink, warm-gray borders — color only where it means something (a status, a series, a warning). A dark page is a deliberate choice, not a style: if you make one, use the dark token values from the starter.
- **Type**: a system sans for text (`ui`-stack in the starter; the console's IBM Plex Sans cannot be loaded in a page), `ui-monospace` for code, data and numbers. Headings heavier and tighter — the console uses Montserrat — rather than bigger than they need to be.
- **Radius** 7px, **borders** 1px at the border color — hairlines, not shadows, separate surfaces.
- **Semantic colors**: `--danger` red, `--ok` green, `--warn` amber — match meaning, not decoration.
- Pele diagrams read `--pele-*` variables live; set them on a wrapper when a page is dark or styled so the diagram matches.

## Structure

- Max-width around 72ch for prose; the common case is a side panel ~360–600px wide, so grids collapse to one column early and nothing needs horizontal scrolling.
- One page, one job. A report page reads top to bottom; a dashboard leads with the numbers; a tool puts its main control first.
- Sections are cards (`--surface`, `--border`, `--radius`) with a real heading — not boxes for their own sake.
- Numbers get a mono face and line up; tables get header rows and hairline rules; empty or loading states get a designed look too.

## Before you ship it — check

Run the page through these in your head and fix what fails; the person sees the result the moment the call returns.

1. **Narrow**: does it hold at 360px wide? Long words, tables, code — nothing overflows.
2. **Empty and long**: a section with no data, a title twice as long as expected, 50 rows instead of 5.
3. **Interactive**: every control works without a network; nothing half-wired.
4. **Self-contained**: no external URL anywhere but the two `/api/artifact-libs/*` scripts; no fetch, no `target="_blank"` doing real work.
5. **Reads alone**: a title and the why up top — someone seeing only the page knows what it is.
