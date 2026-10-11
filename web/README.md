# effect-pi web console

The Next.js UI for the agent console. It talks to the HTTP server in `server.ts`: `/api/*` is rewritten to `http://127.0.0.1:4000` (`API_URL` overrides it).

From the repository root:

```bash
pnpm dev                    # the server on :4000 in watch mode, plus this console on :3001
pnpm --filter web check     # typecheck and tests
```

Open [http://localhost:3001](http://localhost:3001). See the "Web console" section of the root `AGENTS.md` for how it is built.
