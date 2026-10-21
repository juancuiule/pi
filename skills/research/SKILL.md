---
name: research
description: Research a question or topic and come back with a sourced, synthesized answer. Use when the user asks to research, investigate or compare something, find out how something works, or gather material for a decision — anything that needs more than one lookup.
---

# Research

Go from a question to findings the person can act on.

## 1. Frame it

- Restate the question in one line and name the sub-questions the answer needs.
- If the scope or the use is ambiguous — which option space, how deep — ask one `ask_user` question before searching, not an interrogation.

## 2. Gather

- `web_search` when it is installed. Prefer primary sources — docs, specs, release notes, papers — over aggregators, and note dates: "latest" claims go stale.
- The person's own material counts when the research is about it: `read_attachment`, `search_attachment`, workspace files.
- A search that returned nothing, or contradicted the expectation, is a finding too. Record it.
- Never present a snippet as a verified fact. If only snippets support a claim, mark it unconfirmed.

## 3. Write it up

- With a workspace, save `research-<slug>.md` there and give the headline findings in chat.
- Without one, deliver an artifact page when the findings are long or meant to be kept; otherwise answer in the chat. Remember links on an artifact page cannot be clicked — write sources out as text there; links work in chat and markdown.

However it is delivered:

1. **Answer first**: the conclusion in a few sentences, at the confidence the sources earn.
2. **Findings** grouped by sub-question, each claim tied to its source.
3. **Open questions**: what the sources did not settle, and what a follow-up would check.
4. A **Sources** list — every entry a working link or a named document.
