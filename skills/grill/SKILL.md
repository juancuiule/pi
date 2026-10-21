---
name: grill
description: Interview the person with pointed questions until a request, plan or decision is pinned down. Use when the user asks to be grilled, wants help thinking through a spec or decision, says "ask me questions before you start", or when a task is too vague to start well.
---

# Grill

Turn a vague ask into a pinned-down spec by interviewing the person with `ask_user`. The form shows one to four questions at a time, each with options and an "Other" field — so every question you ask should come with the answers you already expect.

## How to run it

1. **Round, don't drip.** Think through everything still undecided, then batch the sharpest questions into one `ask_user` call — four at most. A few short rounds beat one questionnaire; each round can chase what the last one opened.
2. **Ask with teeth.** "Which of these is it?" not "what do you think?" Every question should rule out real options, and the offered choices should be the plausible answers — disagreeing takes one tap, and "Other" is always there.
3. **Go where the risk is.** Scope before details, the load-bearing decision before the cosmetic one. When an answer opens a fork, follow the fork next round instead of marching down a list.
4. **Stop when you could start.** Done means the remaining unknowns are ones the person genuinely wants to decide later — or ones they would rather you just pick. Say so and stop asking.

## Then

- Write the spec back in one tight message, or an artifact when it is meant to be kept: the decisions made, each phrased so it can be checked — "on failure: retry once, then fail the run" — then what is deliberately left open.
- With a workspace and a spec as the work product, save it as a markdown file the person can edit.
- If the interview showed the request is already clear, say that and get on with it — a grill that finds nothing to decide wastes the person's time.
