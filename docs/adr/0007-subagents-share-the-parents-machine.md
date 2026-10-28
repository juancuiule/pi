# Subagents are one level deep and share their parent's Sandbox and approvals

The `task` tool hands a self-contained prompt to a child conversation owned by the call's task, so a long search does not fill the parent's transcript (#73, #97). The child has its own context and model stream but no Seat and no Capacity claim: it works on its parent's machine. `SandboxDoc.owner` points at the creator and `env` follows it to the parent's _current_ Sandbox, so an Upgrade mid-run reaches running children. Giving each child its own Sandbox would cost Capacity and leave the parent unable to see the child's files.

## Decisions

- **Depth one.** The child gets the parent's agent minus `task` (no deeper delegation) and `upgrade_workspace` (it would replace the shared Sandbox under its parent).
- **Approvals go to the root.** A child's `ApprovalDoc` only carries `root`; its gated calls and `ask_user` wait on the root conversation's doc, so the parent's Seat decides, answers, counts and stops them unchanged, and the person sees one queue.
- **Bounded fan-out.** Parallel `task` calls in one round run concurrently, capped at `MAX_SUBAGENTS` (4) per conversation, counted inside the creating commit; an over-cap call returns a normal tool error the model can retry.
- **Replay-safe.** A rerun finds its child by owner task and its submission by `requestId` `subagent:<taskId>`, so a restart never spawns a second child. Ownership also makes abort cascade.
