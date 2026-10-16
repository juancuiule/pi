# effect-pi

A server where people talk to agents in conversations; an agent can run tools on a machine of its own, from none at all up to a full desktop.

## Conversations

**Conversation**: A durable transcript between a person and an agent, with everything recorded about it. It is never lost: it is active, paused or archived. _Avoid_: chat, thread

**Seat**: A Conversation that is live in the server right now: it can run, and it holds a Sandbox when its Workspace needs one. An active Conversation has exactly one Seat; a paused one has none. _Avoid_: session (pi-durable's name for the harness's line of commits), activation, live conversation

**Run**: The agent's work from one prompt to its final answer.

**Pause**: Ending a Seat while keeping the Conversation and its Workspace restorable, which frees its Sandbox. It happens on request, after the current Run ends, or after inactivity. _Avoid_: end, close, sweep, dormant

**Resume**: Starting a new Seat for a paused Conversation. _Avoid_: attach, revive, restore

**Stop**: Aborting the current Run of a Seat; the Seat stays active and keeps its Sandbox. _Avoid_: cancel, interrupt

**Archive**: Hiding a Conversation and discarding its Workspace's files. The transcript stays readable, and an archived Conversation can be unarchived with an empty Workspace. _Avoid_: end, delete

**Approval**: A person's decision on a tool call that waits for one before it runs.

**Attachment**: A file a person sends with a message: its original, kept privately on the server, and the text or image prepared from it once. Before a message takes it, it is an upload: staged (no Conversation yet) or a Conversation's, and it expires unsent. _Avoid_: document, file upload, asset

**Artifact**: A sandboxed HTML page the agent writes for the person, kept privately on the server with every version of it. _Avoid_: file, document, page

## Workspaces

**Workspace**: The durable machine side of a Conversation: its Level and its files. _Avoid_: volume, environment

**Level**: How much machine a Workspace has: none, shell or desktop. It only goes up. _Avoid_: sandbox choice, kind, tier

**Upgrade**: Raising a Workspace's Level, asked for by the person or by the agent.

**Sandbox**: A running machine over a Workspace. It exists only while its Conversation has a Seat. _Avoid_: container, VM

**Shell**: The console's live terminal in a Conversation's Sandbox: a real PTY over a WebSocket, not the agent's command output (that is the Agent tab). _Avoid_: exec, agent terminal

**Capacity**: How many Sandboxes the server runs at once. _Avoid_: cap, limit, slots
