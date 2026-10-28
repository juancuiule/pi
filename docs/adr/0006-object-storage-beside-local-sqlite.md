# Files move to object storage; the database stays local SQLite under Litestream

The server's files (attachments, screenshots, org skills, Workspace snapshots) can live in buckets in one S3-compatible store (SeaweedFS locally), behind one small `ObjectStore` interface, so each kind moves one adapter at a time. `EFFECT_PI_DB` stays a local SQLite file, replicated to a bucket by Litestream: one server needs no database server, and a lost disk is recovered by restoring the replica. Everything is opt-in: `STORAGE=local` and `WORKSPACE_STORAGE=docker-volume` keep the original behavior (#45).

## Decisions

- **Workspaces are copied, not mounted** (`WORKSPACE_STORAGE=s3-copied`). The Docker volume becomes a cache: `save` tars `/workspace` inside the Sandbox, compresses with zstd on the host and uploads `<id>/files.tar.zst`; `restore` streams it back into a fresh Sandbox. Mounting S3 as a filesystem was not an option for the tools the agent runs.
- **A snapshot is never overwritten by a worse copy.** A failed restore skips the closing save (a half-populated mount must not replace a good snapshot); a failed save keeps the cache. Saves of one Workspace are serialized, so a Run-end checkpoint and the closing save never overlap. A recorded reference under a different adapter fails the open instead of starting empty.
- **Skills get two namespaces**: `builtin`, converged from the repository at startup, and the writable `org` overlay that shadows it.
- Every implementation passes the same contract suites (`*.contract.ts`), run against SeaweedFS with `S3_TESTS=1`.

## Consequences

Pause and Resume of a large Workspace cost real time: about 21s to save and 51s to restore 200MB, limited by `appendFile` chunking through the Sandbox's daemon.
