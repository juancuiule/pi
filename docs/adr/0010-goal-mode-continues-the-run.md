# Goal mode continues the Run from an `onYield` hook over a goal document

`/goal <objective>` asks the agent to keep working until the goal is done instead of stopping at its first answer. The goal is a per-conversation document (`app.goal`); while it is active, an `onYield` hook on pi-durable's generation task runs at every final answer and either ends the goal or returns `{ continue }` with an automatic `<goal_continuation>` message. pi-durable appends that message in the same commit that records the answer and hands the Run to a successor generation, so the whole goal is one Run: Stop, approvals, `ask_user`, the console's running state and Pause-after-Run work unchanged. ADR-0009 is left to the base-image work in flight on another branch.

## Decisions

- **Inside the Run, not one Run per turn.** A run-end watcher in `Conversations` that submits the next input would be a second writer racing the person's follow-ups, the Pause and the idle sweep, and would need its own dedupe across restarts. The hook's continuation is atomic with the answer and is dropped by pi-durable when the person's follow-up is queued, which is the behaviour we want.
- **Ends by the todo list, the agent, a budget or the person.** Completed when every item of the Todo list is completed (the list is cleared when a goal starts, so an old finished list cannot end it), `end_goal` (done or blocked), a turn budget (`GOAL_MAX_TURNS`, 20) and a cost budget over the conversation and its subagents (`GOAL_MAX_COST_USD`, $5), Stop or cancel. Asking the person (`ask_user`, approvals) just waits, as in any Run.
- **Replay-safe.** Hooks may rerun after a crash before the consuming commit, so the decision is memoized per generation task (`api.memo`) and applied to the doc idempotently (`turns = max(turns, turn)`, status only from `active`).
- **Survives Pause and restart as a document.** A restart aborts every Run (ADR-0001), so the goal is not resumed by itself: Resume, or the console's Continue, submits the next continuation as an input with `requestId` `goal:<id>:<turn>` and `whenBusy: "reject"`, so racing callers submit one. A Pause during a goal's Run holds the goal in process: the next yield does not continue, the Run ends and the Seat closes with the goal still active.
- **The person's messages win.** A message sent during a goal queues as a follow-up; its Run's yield continues the goal afterwards. The goal's continuation messages are marked so the console shows them as automatic, and typed `<goal` tags are escaped.

## Considered options

- Re-prompting from the console when a Run ends: dies with the tab and doubles on two tabs.
- A goal that keeps going until the model alone says done: without the todo list's state and a budget, a model that never calls the tool runs forever.
