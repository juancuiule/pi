# A deployment is a host plus exposures, sharing one base and one edge

`deploy/pi` (Cloudflare Tunnel on a Raspberry Pi) and `deploy/lan` (Caddy on a Debian machine) mixed two separate questions: where effect-pi runs, and how far it is exposed. `deploy/lan` reached into `deploy/pi`'s compose file for its services, so editing the Pi's silently changed the LAN's. The rule that sends the Shell and desktop WebSockets to the server, because the console's `/api` rewrite cannot carry them, was written in the tunnel config, the Caddyfile and three docs. The deploy steps and their order (account before exposure, Sandbox images before the server) lived in prose.

## Decisions

- **Two axes.** The host is any Linux machine with Docker; nothing in `deploy/` depends on it, and what differs is advice (`docs/deploy/hosts.md`). Exposures (`lan`, `tailscale`, `cloudflare`) are adapters a host combines, chosen by `EXPOSURE` in a git-ignored `deploy/.env`.
- **One base, one edge.** `deploy/compose.yml` holds the server, the console, the Sandbox image builds and a Caddy edge with the only copy of the routing rule. Every exposure forwards everything to the edge: the LAN by the edge listening on every interface, Tailscale by `tailscale serve` on the host, Cloudflare by cloudflared with `--url`, so no tunnel config or identity is committed.
- **One converging command.** `deploy/deploy.sh` builds every image, starts the app, asks before exposing a server with no account, turns the exposures on, and checks each `PUBLIC_URL` host through the edge. Hosts need only Docker, bash and curl. Builds run without provenance attestations, so an unchanged image keeps its id: unchanged containers stay up, and Software images, tagged by their base image's id (ADR-0004), stay valid.

## Rejected

- **The server as the single origin**, forwarding non-`/api` requests to the console, so each exposure has one route and no edge. It removes a hop but puts a streaming proxy into the server, beside the loopback and Host checks that guard every request. Revisit if the edge's hop shows a cost.
- **A Tailscale container** with its own auth key and node name: the host needs nothing, but it renames the machine on the tailnet and runs a second tailscaled beside the host's.
- **A folder per host** (`deploy/pi`, `deploy/lan`): a third host would copy a folder, and the routing rule with it.
