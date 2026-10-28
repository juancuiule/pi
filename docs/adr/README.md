# Architectural Decision Records

One file per decision that is hard to reverse, surprising without context, and the result of a real trade-off: what was decided and why. Terms are defined in [GLOSSARY.md](../../GLOSSARY.md); how the code works today is in [AGENTS.md](../../AGENTS.md).

- Files are `NNNN-slug.md`, numbered in order; the next one takes the highest number plus one.
- An ADR is not rewritten when a decision changes: a new one supersedes it, and the old one gets `Status: superseded by ADR-NNNN` at the top.
- Sketches that have not shipped stay out of the repository.

| ADR | Decision |
| --- | --- |
| [0001](0001-seats-and-workspaces.md) | Conversations pause instead of ending; only the Workspace is stored |
| [0002](0002-attachments-prepared-at-upload.md) | Attachments are checked and prepared once, at upload, in a worker |
| [0003](0003-artifacts-fetch-nothing.md) | Artifact pages fetch nothing; what the CSP would block is refused at write time |
| [0004](0004-software-as-layered-images.md) | Software is built into layered images on demand, not installed at start |
| [0005](0005-shell-pty-owned-by-the-sandbox.md) | The Shell is a PTY over the Engine API, owned by the Sandbox, not the socket |
| [0006](0006-object-storage-beside-local-sqlite.md) | Files move to object storage; the database stays local SQLite under Litestream |
| [0007](0007-subagents-share-the-parents-machine.md) | Subagents are one level deep and share their parent's Sandbox and approvals |
