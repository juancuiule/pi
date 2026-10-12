# Skills

Each folder here is an [Agent Skill](https://agentskills.io/specification): a `SKILL.md` with frontmatter, plus any files it bundles. `index.ts` loads every folder with a `SKILL.md` (this README is not one) and gives the skills to all conversations.

```text
repo-report/
├── SKILL.md                    # frontmatter + instructions
├── scripts/repo-stats.sh       # runs in the sandbox, from .skills/repo-report/
└── assets/report-template.md   # loaded on demand with the skill tool
```

## How the agent uses them

1. The system prompt lists each skill's `name` and `description`, nothing more.
2. When a task matches a description, the model calls `skill({ name })` and gets `SKILL.md`, headed by a list of the files the skill bundles.
3. It loads a bundled file only when the instructions point to it: `skill({ name, file: "references/x.md" })`.
4. In a sandboxed conversation every skill is also copied to `.skills/<name>/`, so its scripts can run with `bash`.

Each `skill` call is a tool span in Langfuse, so you can see whether and when the model picked a skill up.

To force a skill instead of waiting for the model to choose it: `pnpm start "/skill:<name> <request>"`. In the web console, type `/` in the message box to pick a skill, or choose one in the sidebar's Capabilities sheet.

## Writing one

- `name`: lowercase letters, digits and single hyphens, at most 64 characters, matching the folder name.
- `description`: what the skill does and when to use it, at most 1024 characters. It is all the model sees when deciding, so name the situations: "Use when the user asks to convert…".
- `disable-model-invocation: true` hides the skill from the list; it then loads only through `/skill:<name>`.
- `compatibility`: what it needs, such as "Needs a shell sandbox". Informational.
- Keep `SKILL.md` to the steps, and move long tables, templates and examples into bundled files the steps point to.
- Refer to bundled files by their path relative to the skill folder.

`pnpm test` checks that every skill here loads without problems.
