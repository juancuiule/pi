# Skills

Each folder here is an [Agent Skill](https://agentskills.io/specification): a `SKILL.md` with frontmatter, plus any files it bundles. `server.ts` loads every folder with a `SKILL.md` (this README is not one) and gives the skills to all conversations. These are the built-in skills; skills written at runtime live outside the repo under `SKILLS_ORG_DIR` (`data/skills` by default), and the agent can author them itself with its `skill_save` tool — an org skill with a builtin's name shadows it.

```text
diagrams/
├── SKILL.md                  # frontmatter + instructions
└── references/types.md       # loaded on demand with the skill tool
```

## How the agent uses them

1. The system prompt lists each skill's `name` and `description`, nothing more.
2. When a task matches a description, the model calls `skill({ name })` and gets `SKILL.md`, headed by a list of the files the skill bundles.
3. It loads a bundled file only when the instructions point to it: `skill({ name, file: "references/x.md" })`.
4. In a sandboxed conversation every skill is also copied to `.skills/<name>/`, so its scripts can run with `bash`.

Each `skill` call is a tool span in Langfuse, so you can see whether and when the model picked a skill up.

To force a skill instead of waiting for the model to choose it, start the message with `/skill:<name> <request>`. In the web console, type `/` in the message box to pick a skill, or choose one in the sidebar's Capabilities sheet. To suggest a skill without forcing it, mention `/skill:<name>` later in the prompt, as in `draw this as a flowchart, maybe /skill:diagrams helps`: the model gets the skill's description and loads it if it fits.

## Writing one

- `name`: lowercase letters, digits and single hyphens, at most 64 characters, matching the folder name.
- `description`: what the skill does and when to use it, at most 1024 characters. It is all the model sees when deciding, so name the situations: "Use when the user asks to convert…".
- `disable-model-invocation: true` hides the skill from the list; it then loads only through `/skill:<name>`.
- `compatibility`: what it needs, such as "Needs a shell sandbox". Informational.
- Keep `SKILL.md` to the steps, and move long tables, templates and examples into bundled files the steps point to.
- Refer to bundled files by their path relative to the skill folder.

`pnpm test` checks that every skill here loads without problems.
