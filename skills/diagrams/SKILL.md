---
name: diagrams
description: Draw a diagram the person can see — a mermaid-syntax fence in your reply, or pele on an artifact page. Use when the user asks for a diagram, flowchart, sequence, ER, state or architecture picture, or when a structure reads better drawn than written.
---

# Diagrams

A fenced block tagged `mermaid` in your reply renders as a diagram in the chat. An artifact page draws the same syntax bigger with pele, loaded from `/api/artifact-libs/pele.global.js`: `pele.mount(el, source)` renders into an element and refits it when the page resizes.

```html
<div id="diagram"></div>
<script src="/api/artifact-libs/pele.global.js"></script>
<script>
  pele.mount(
    document.getElementById("diagram"),
    `flowchart TB
    A[Start] --> B[Done]`
  );
</script>
```

## 1. Pick the surface

- Reply fence for one diagram that answers the question and is read once beside your text.
- An artifact for a deliverable: several diagrams, a diagram beside text or tables, or anything the person keeps. Dark or styled pages theme the diagram through `--pele-*` CSS variables, which pele reads live.
- Numbers over time or categories belong in a Chart.js artifact. A drawn pie or bar chart is for a handful of parts, not real data.

## 2. Pick the type

Load `references/types.md` with the skill tool. It names each type, what it shows, and a smallest working example. Match the type to the data instead of bending a flowchart into a timeline or a class diagram into boxes and arrows.

## 3. Write the source

Start from the type's example in the reference, then keep it drawable:

- Quote every label that holds spaces, punctuation or parentheses: `A["load (csv)"]`, never `A[load (csv)]`.
- Labels are a few words; the detail goes in your message or the page.
- `flowchart TB` (top to bottom) past a handful of nodes; `LR` stays readable only for a few.
- A line break is `\n` inside a quoted label. HTML tags in labels are dropped, they do not break lines.
- `click X "https://…"` opens that link in a new tab. JavaScript callbacks are ignored, so never rely on one.
- Balance every `subgraph` with its `end`, and every `[`, `(` and `{` you open.

## 4. Ship it

You cannot see the render; the person sees it, or the error where it should be. Keep the source small enough to check by eye before you send it. Say what the diagram shows, so a render that went wrong still leaves the answer in your message.
