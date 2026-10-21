---
name: explain-diff
description: Explain a code change as a readable walkthrough — what changed, why, and how the pieces fit. Use when the user asks to explain a diff, a branch, a commit, a PR, or "what changed", or wants a walkthrough of a change for review.
---

# Explain a diff

Produce a self-contained artifact page that walks the reader through a change, ordered by what the reader needs to understand — not by file order.

## 1. Get the diff

- With a workspace, run git in it: `git diff <base>...HEAD` for a branch, `git show <commit>` for one commit, `git diff` for uncommitted work. If the base is not obvious, ask with `ask_user` — the default branch is a good first option to offer.
- Without a workspace, explain the diff or the change the person pasted or describes. If it is not enough to explain, say what to bring.

## 2. Understand before you write

Read the diff until you can say what the change _does_ and _why_, not just which files it touches. A diff never shows the whole story — follow the code around it: callers, callers' callers, the config the diff assumes. Check what the change claims to do against what it actually does; a mismatch is the most valuable thing in the walkthrough.

## 3. Build the page

`artifact_create`, one self-contained HTML page:

- **Start with the why.** One paragraph on what the change is for, in plain language, before any code.
- **Group by meaning, not by file.** Each section gets a heading, a short prose explanation, and only the excerpt that carries its point — trim the hunk to the lines that matter instead of dumping it. Order sections so each builds on the last (the new flow, then where it plugs in, then the edge cases).
- **Mark additions and removals.** Style `+` and `−` lines differently so the reader sees the delta, and keep enough context around each excerpt that it reads as code, not fragments.
- **End with what to look at.** Risks, edge cases, spots worth a reviewer's attention, anything you could not verify from the diff alone.

Keep the page inside the artifact rules: inline styles and scripts, no external assets. The `artifact-design` skill covers the house style. In your reply describe what the walkthrough says, at headline level — the person already sees the page.
