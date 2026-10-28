# The Shell is a PTY over the Engine API, owned by the Sandbox, not the socket

The console's Shell tab is a live `bash -l` in the Sandbox (#32). It runs through the Docker Engine API over the Unix socket (exec create, hijacked start, exec resize) instead of the `docker exec` CLI, because resizing needs the exec id and the CLI never exposes it. Closing the hijacked socket does not kill the exec'd process, so the PTY's process group is killed explicitly when its owner closes.

That owner is the Sandbox's lifetime (`machine.scope`), not the WebSocket (#36). When the socket owned the exec, every remount killed the shell: switching conversations, reloading the page or a network drop lost the scrollback, the working directory and any running job. Now sockets attach and detach: each attach replays recent scrollback (256 KiB) and then follows live, and only Pause, Upgrade or Archive end the shell, with its Sandbox.

## Considered options

- Keeping every visited conversation's terminal mounted but hidden in the console: rejected because it still ties the process to the socket, holds one socket per visited conversation and loses everything on reload.

## Consequences

Two tabs attached to one conversation share one shell, tmux-style: input from both, and the latest attach's size wins.
