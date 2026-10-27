# effect-pi

A self-hosted server and web console for working with AI agents, where each conversation can get a computer of its own when it needs one.

You start a conversation in the console and choose how much machine the agent gets:

- **none** is a plain chat. The agent can still read your attachments, search the web, write artifacts and ask you questions, but it runs no commands.
- **shell** is a Linux container with a terminal and a `/workspace` folder. The agent reads, writes and runs code there, and you can open the same shell yourself.
- **desktop** is the shell plus a graphical desktop. The agent sees it through screenshots and controls it with the mouse and keyboard, and you watch it live in the console.

A conversation can move up a level later, because you asked or because the agent requested it and you approved. It keeps its files.

This is a personal experiment. I want to find out what a good everyday agent environment looks like when I control the whole stack, and to learn [Effect](https://effect.website) and [pi](https://github.com/earendil-works/pi) by building it.

## The idea

Most agent products pick one shape: a chat box, a coding agent in your terminal, or a computer-use demo. A single task often needs more than one. You ask a question, then you want a script run, then you need a website clicked through. I want one conversation that starts as a chat, gets a shell or a desktop when the task needs one, and that the server never loses.

These principles drive the design.

- **Conversations are durable.** Nothing "ends". A conversation is active, paused or archived. Pausing frees its machine but keeps the transcript and the files, so you can resume it days later. Restarting the server pauses every conversation and loses none.
- **Machines are limited and shared.** The server runs a fixed number of shells and desktops at once. When it is full, it never stops a conversation to make room. It shows you which conversations hold the machines and lets you choose one to pause. A conversation idle for 30 minutes pauses itself.
- **You decide what the agent does.** Under the `ask` policy, every file write, command and desktop action waits for your approval. The agent can ask you multiple-choice questions instead of guessing. You can switch tools, skills and settings per conversation, and each change appears in the transcript.
- **The agent produces things you can keep.** Artifacts are HTML pages the agent writes for you, such as reports, charts or small tools. The server keeps every version and renders each one in a sandboxed frame that loads images only from domains you trust and fetches nothing else. Attachments can be PDFs, spreadsheets, images or text. The server extracts their contents once, and the agent cites them by page or row.
- **Every step is traced.** Each model request and tool call goes to a local [Langfuse](https://langfuse.com), where you can see what the agent did and what it cost.

[`GLOSSARY.md`](GLOSSARY.md) defines the terms the code uses, such as Conversation, Seat, Workspace, Sandbox, Level, Pause and Upgrade. Read it first to understand how the parts relate.

## What it can do today

- Conversations at three levels, with upgrades, pause, resume, archive and capacity limits
- A web console with a streaming transcript, a live terminal, a live desktop view, approvals and questions, a capabilities sheet, search across conversations, and Markdown or JSON export
- Docker sandboxes, where you can add software such as Node.js, Python data science libraries, ImageMagick, FFmpeg or Chrome
- Attachments in text, Markdown, HTML, CSV, TSV, PDF (with a text layer), PNG, JPEG and WebP
- Artifacts, versioned HTML pages that load images only from domains you list as trusted
- Skills in the [Agent Skills](https://agentskills.io/specification) format, which you or the agent can write and edit
- Subagents, child agents that take self-contained parts of a task and run in parallel
- Web search through a self-hosted [SearXNG](https://docs.searxng.org)
- Remote MCP servers as extra tools
- Models from Anthropic, OpenAI, the Vercel AI Gateway or a local Ollama

## Where it is going

Today it is a tool for one person on localhost, with no accounts. I wrote up the questions I am exploring in [`docs/plans/`](docs/plans/):

- Personal defaults, a library of files and procedures, and memory you can inspect and undo ([research](docs/plans/personal-agent-platform-research.md))
- Agent profiles, object storage and collaboration between people ([research](docs/plans/agent-profiles-storage-and-collaboration-research.md))
- Scheduled workflows, agents that run on a timer ([research](docs/plans/scheduled-workflows-research.md))
- Sandbox backends other than local Docker ([research](docs/plans/opensandbox-research.md))

These are proposals, not commitments.

## How it is built

- **[Effect](https://effect.website)** structures the server with services, layers, resource scopes, typed errors and the HTTP API. A conversation's sandbox belongs to a scope, and closing the scope removes the sandbox.
- **[pi](https://github.com/earendil-works/pi)** provides the agent. `pi-ai` talks to the models. `pi-durable` runs the agent loop over a durable store, so a conversation survives restarts. `pi-mcp` connects MCP servers.
- **Docker** runs the sandboxes. Each container runs pi's execution daemon, and the server talks to it over `docker exec`. The desktop image runs XFCE and serves it through noVNC.
- **SQLite** in WAL mode stores conversations, attachments and artifacts. Workspace files live in Docker volumes or in S3-compatible storage.
- **Next.js** with shadcn renders the web console in [`web/`](web/), which imports the server's typed API definition.

The repo vendors Effect and pi under [`repos/`](repos/), pinned to the versions in use, as reference material.

## Running it

You need Node.js, [pnpm](https://pnpm.io) and Docker. Docker is only for shell and desktop conversations.

```sh
pnpm install
pnpm sandbox:build      # builds the shell and desktop images
pnpm dev                # API on :4000, console on http://localhost:3001
```

Configuration goes in a `.env` file, which git ignores. [`.env.schema`](.env.schema) documents every variable and its default. With no model configured, the server answers with an echo model, which is enough to explore the console. To use a real model, set one API key in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY`), or set `OLLAMA_URL` to an Ollama server.

Two extras are optional:

- `pnpm langfuse:up` starts a local Langfuse and writes its keys to `.env`, so traces appear there.
- `pnpm searxng:up` starts SearXNG. Set `SEARXNG_URL` to give the agent web search.

The server listens on `127.0.0.1` and has no authentication. Do not expose it to a network.

## Development

`pnpm check` runs environment validation, typecheck, lint, format and tests. The tests use a fake model provider and local folders instead of containers, so they need no API keys and no Docker. `pnpm test:docker` and `pnpm test:integration` run slower suites against real containers and services.

[`AGENTS.md`](AGENTS.md) is the detailed guide to the codebase. Its audience is coding agents, but people can read it too.
