# Conversations pause instead of ending; only the Workspace is stored

Conversations used to end, and their sandbox was removed with them. A Conversation now can never become impossible to restore: it is active (it has a Seat), paused, or archived. Of that state only `archivedAt` and the Workspace (Level, storage reference) are stored; active, paused and "pausing after this Run" live only in the process, so after a restart every Conversation is paused and in-flight Runs are aborted. Recovering live Runs across a restart would mean persisting Seats and Sandboxes, which a single server does not need.

## Decisions

- A Workspace's files live in storage behind an adapter that outlives the Sandbox (a mounted Docker volume, or a copied snapshot, see [ADR-0006](0006-object-storage-beside-local-sqlite.md)). A stopped container is never relied on.
- A Level only goes up (none, shell, desktop). An Upgrade carries `/workspace` only. The desktop image is built `FROM` the shell image.
- Capacity counts `seat`, `shell` and `desktop`. At a limit nothing is evicted: the request fails with the holders of the short resource and the person picks one to Pause. Silently pausing someone's live work would be worse than asking.
- Stop aborts the Run and keeps the Seat; Pause frees it, at once when idle, otherwise after the Run. A `send` cancels a pending Pause.
- Archive deletes the Workspace's files but keeps the transcript; unarchiving restores it with an empty `/workspace`.
- One server. Databases from before this change were not migrated.

## Consequences

`Agents` assembles a Seat (Sandbox, `SandboxDoc`, skills, conversation) and `Conversations` decides when Seats come and go (Pause, Resume, the idle sweep, run status from `LiveDoc`).
