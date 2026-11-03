# Deploying effect-pi

A deployment has two independent parts:

- **The host**: any Linux machine with Docker, such as a Raspberry Pi, a desktop on your network, or a VPS. Nothing in `deploy/` depends on which one; [hosts.md](hosts.md) has the advice that does.
- **The exposure**: how far the site reaches. `lan` (your local network), `tailscale` (your devices anywhere, over your tailnet) and `cloudflare` (the internet, through a Cloudflare Tunnel behind Access). A host can use several at once. [exposure.md](exposure.md) sets each one up.

```
                     ┌─ lan: the edge listens on LAN_PORT, every interface
browser ──> exposure ┼─ tailscale: tailscale serve ──┐
                     └─ cloudflare: cloudflared ──────┤
                                                      v
                               edge (Caddy) on the host
                               ├── /api/conversations/*/(shell|desktop), /api/dictation ──> server :4000 (WebSockets)
                               └── everything else ──> console :3001 ──/api──> server :4000
```

The server and the console listen on 127.0.0.1 only. The edge (`deploy/Caddyfile`) holds the one routing rule: the console's `/api` rewrite cannot carry WebSockets, so the Shell tab, the desktop and dictation go straight to the server. The microphone needs a secure context, so dictation works through an https exposure (tailscale, cloudflare) or on localhost, not over the plain-http LAN URL. Every exposure forwards everything to the edge.

## Configure

Two files, both git-ignored:

`.env` at the repository root is the server's configuration (see `.env.schema`). A deployment needs `PUBLIC_URL`: every URL people type, comma-separated. The server answers 403 to any other host, and `deploy.sh` refuses to start an exposure that has no URL of its kind.

`deploy/.env` is this host's deployment:

```sh
EXPOSURE=lan,tailscale    # one or more of lan, tailscale, cloudflare
DOCKER_GID=989            # stat -c %g /var/run/docker.sock
LAN_PORT=80               # lan: where the edge listens on every interface
EDGE_PORT=8080            # without lan: where the edge listens on 127.0.0.1
CLOUDFLARE_TUNNEL=<id>    # cloudflare: the tunnel's id
```

## Deploy

```sh
deploy/deploy.sh
```

It converges the host to `deploy/.env`, so rerun it after every pull or configuration change:

1. Builds the app image and both Sandbox images. Unchanged images keep their ids, so unchanged containers stay up and Software images stay valid.
2. Starts the server and the console, and waits until they are healthy.
3. If no account exists, warns that whoever opens the site first can create it, and asks: create it now, expose anyway, or abort. Without a terminal it aborts unless given `--expose-without-account`. Once an account exists it never asks again.
4. Starts the edge and the chosen exposures, and stops cloudflared when `cloudflare` is no longer chosen.
5. Checks every `PUBLIC_URL` host through the edge: the console page, the server through the console's `/api` rewrite, and the socket route.

Later accounts: `docker compose -f deploy/compose.yml exec server node user.ts add <name>`.

## Data

Conversations, accounts and attachments live in the `effect-pi_effect-pi-data` volume (the Compose project is `effect-pi`). Rebuilding or redeploying keeps it. Restarting the server pauses every conversation: each one resumes on its next message.

`pnpm check` runs `pnpm deploy:check`, which validates `deploy/compose.yml`, the Caddyfile and `deploy.sh` without starting anything.
