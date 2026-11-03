# One activity stream per signed-in console, events from the Seat's edges

Status: accepted

The console notifies the person (browser Notifications) and badges its favicon when a Run ends or a call waits for them, including for conversations it has no events stream open for.

## Decision

- The server publishes an `Activity` (`finished`, `failed`, `approval`, `question`) from the places that already see every transition: the running-to-idle edge in `Conversations.refresh` (the same edge that indexes, checkpoints and titles), which then reads the last settled input's outcome; and a watch on each Seat's `ApprovalDoc`, which reports each newly pending key once. A stopped Run or a withdrawn input is not reported.
- `GET /api/activity` streams the caller's Activity over SSE: one connection per console tab for all their conversations, filtered by owner on the server. It starts with a `ping` and repeats it every 25s.
- The console turns an Activity into a Notification only when useful (tab hidden, or another conversation than the one on screen), and refetches the conversation list on each, so the dots, favicon and `(n)` title prefix move at once. Preferences are per browser (localStorage).

## Why

- Diffing the 2s list poll in the browser misses Runs shorter than the interval, and the poll pauses in a background tab (TanStack Query) and is throttled to once a minute by Chrome after five hidden minutes, exactly when a notification matters.
- One stream per conversation would spend the browser's six connections per host.
- Web Push (a follow-up) needs the server to decide when to notify with no tab open; publishing at the edges puts that decision on the server already, so a push sender is one more subscriber.
- A scheduled Run ends through the same edge as any other, so "notify on finish" needs nothing from schedules.

## Rejected

- Polling the list in the background (`refetchIntervalInBackground`): throttled, and it still misses short Runs.
- A stream of whole summaries recomputed on the server on a timer: polling moved to the server, and every subscriber reads every conversation's submissions each tick.
- The `ping` first is not optional: an SSE response that writes nothing does not reach the client, which then waits.
