# Seats and Workspaces

Replaces ended and sandbox-removed conversations with pausable ones, and splits `Agents` and `Conversations` by responsibility. Terms are defined in [GLOSSARY.md](../../GLOSSARY.md).

## Decisions

- No Conversation becomes impossible to restore. A Conversation is active (it has a Seat), paused, or archived.
- Only `archivedAt` and the Workspace (Level, storage reference) are stored. Active, paused and "pausing after this Run" exist only in the process; after a restart every Conversation is paused and in-flight Runs are aborted.
- A Workspace keeps its files in `/workspace` storage behind a storage adapter. `WorkspaceDoc` holds an opaque storage reference. An adapter may contribute mounts when a Sandbox is created (mounted style) or save when it is released (copied style). Only the Docker-volume adapter is built now. A stopped container is never relied on.
- A Level only goes up (none, shell, desktop). An Upgrade carries `/workspace` only; the person or the agent asks for it, and the agent's request waits like a Seat request. The desktop image is built `FROM` the shell image.
- Capacity counts `seat`, `shell` and `desktop`. Every Seat takes a `seat`; a shell or desktop Seat also takes one `shell` or `desktop`. At a limit, nothing is evicted: the request fails with the holders of the short resource, and the console lets the person pick one to Pause; that request can wait for the chosen Seat. All waits for capacity are in one list.
- Stop aborts the current Run; the Seat stays. Pause frees the Seat: at once when idle, otherwise after the Run ends; a `send` cancels a pending Pause, and a Stop makes it take effect. Resume happens on `send` or by an explicit action. The idle sweep pauses Seats idle for 30 minutes.
- A Stop clears what the aborted calls leave in `ApprovalDoc`; a call aborted while waiting for approval reports "Stopped by the user before approval".
- Archive hides a Conversation and deletes its Workspace's files; unarchiving restores it with an empty `/workspace`.
- Approvals are decided on a Seat. `/skill:` is expanded by the Seat's `send` (and by `open` for the first prompt), before any capacity is taken.
- One server. Existing databases are not migrated: delete `data/effect-pi.sqlite*`.

## Modules

- **`Capacity`**: limits, holders and the wait list for `seat`, `shell` and `desktop`. `Conversations` claims Seats (and, for a create, the Level's resource before anything is recorded); `Agents` claims a Seat's Sandbox resource, and waits for one on the agent's Upgrade.
- **`Workspaces`**: Workspace storage (create, archive) and Sandboxes for a Workspace at a Level, through the `Sandboxes` backend.
- **`Agents`**: the harness, boot recovery, stored Conversations (list, archive), and `open(id)`, which assembles a Seat: Sandbox, `SandboxDoc`, skills, conversation; on close it aborts the conversation before the Sandbox goes. A Seat offers `send`, `stop`, `decide`, `upgrade` and `events`.
- **`Conversations`**: which Conversations have Seats and when that changes: Pause, Resume, the sweep, run status from `LiveDoc`, and the API's view of Capacity.

## Steps

All done on `feature/seats-and-workspaces`; each step left `pnpm check` green.

1. Build the desktop image `FROM` the shell image.
2. "Stopped by the user before approval": the `stop` decision and `stopWaitingCalls` (`src/approvals.ts`), and a Stopped state in the console.
3. `Capacity` and `Workspaces` with the Docker-volume storage adapter, and `WorkspaceDoc`.
4. `Agents.open` and the Seat handle (`send`, `stop`, `decide`, skill expansion); `MetaDoc.archivedAt`; `ask` moves to the test helpers.
5. `Conversations` with Pause and Resume instead of end and close; run status from `LiveDoc`.
6. API and console: Pause, Resume, Stop, Archive, the limit dialog.
7. Upgrade (person and agent) and the wait list.

Later: full-filesystem snapshots (a committed image), a copied-style storage adapter, more on skills and progressive disclosure.
