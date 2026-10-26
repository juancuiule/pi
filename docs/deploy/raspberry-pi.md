# Running on a Raspberry Pi behind a Cloudflare Tunnel

The server listens on 127.0.0.1 only. `cloudflared` runs on the Pi, connects out to Cloudflare, and forwards `https://pi.example.com` to the console on localhost. Nothing listens on the LAN or the internet.

```
browser ──https──> Cloudflare (Access) ──tunnel──> cloudflared on the Pi
                                                    ├── /api/conversations/*/shell ──> server :4000 (WebSocket)
                                                    └── everything else ───────────> console :3001 ──/api──> server :4000
```

## What works remotely

- Levels `none` and `shell`: chats, files, the Shell tab, artifacts, attachments.
- Not `desktop`: noVNC is published on a random 127.0.0.1 port of the Pi, which a remote browser cannot reach. Set `MAX_DESKTOPS=0`.

## The Pi

- A 64-bit OS (Raspberry Pi OS 64-bit or Ubuntu arm64): the sandbox images are `ubuntu:24.04`, and the pi-env daemon ships an arm64 build. 8 GB of RAM is comfortable; lower `MAX_SHELLS` on smaller boards.
- A current Node (the one this repo develops on; `node server.ts` relies on type stripping), pnpm, and Docker Engine with your user in the `docker` group.
- Leave Langfuse and SearXNG off unless you need them; both are heavy for a Pi.

```sh
git clone <this repo> && cd effect-pi
pnpm install
# The shell image, built for the Pi's arm64; `pnpm sandbox:build` also builds desktop, which is not needed here.
docker build -t effect-pi/sandbox-shell -f docker/sandbox/shell.Dockerfile docker/sandbox
touch .env
```

`.env` (see `.env.schema` for every variable):

```sh
PUBLIC_URL=https://pi.example.com
MAX_DESKTOPS=0
MAX_SHELLS=2
# A model: an API key, or Ollama on another machine
ANTHROPIC_API_KEY=sk-ant-...
```

`PUBLIC_URL` makes the server accept requests whose Host or Origin is that URL, beside loopback ones, and marks the session cookie `Secure` for requests that came through it.

## Build and run

Run the production console, not `pnpm dev`: the dev server is slow on a Pi and exposes Next's dev tooling.

```sh
pnpm --filter web build
pnpm server                 # terminal 1 (or a systemd unit)
pnpm --filter web start     # terminal 2
```

Example systemd unit for the server (`/etc/systemd/system/effect-pi.service`); the console's is the same with `ExecStart=/usr/bin/env pnpm --filter web start`:

```ini
[Unit]
Description=effect-pi server
After=docker.service network-online.target
Requires=docker.service

[Service]
User=pi
WorkingDirectory=/home/pi/effect-pi
ExecStart=/usr/bin/env pnpm server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Create your account before opening the tunnel

The first account comes from the setup screen, and anyone who reaches it first gets it. Open `http://localhost:3001` on the Pi (or over `ssh -L 3001:localhost:3001 pi`) and create it there. Later accounts come from `pnpm user add`.

## The tunnel

```sh
cloudflared tunnel login
cloudflared tunnel create effect-pi
cloudflared tunnel route dns effect-pi pi.example.com
```

`~/.cloudflared/config.yml`; the shell rule must come first, because the console's `/api` rewrite cannot carry WebSockets:

```yaml
tunnel: effect-pi
credentials-file: /home/pi/.cloudflared/<tunnel id>.json
ingress:
  - hostname: pi.example.com
    path: ^/api/conversations/[^/]+/shell$
    service: http://localhost:4000
  - hostname: pi.example.com
    service: http://localhost:3001
  - service: http_status:404
```

Do not set `originRequest.httpHostHeader`: the server checks the Host header against `PUBLIC_URL`.

Install it as a service with `sudo cloudflared service install`.

## Put Cloudflare Access in front

In Zero Trust → Access → Applications, add a self-hosted application for `pi.example.com` with a policy that allows only your email. Then nobody else reaches the sign-in page at all, which matters because:

- sign-in failures are throttled per name, so someone who knows your user name can lock it for up to 15 minutes at a time;
- every sign-in attempt costs a scrypt hash (32 MiB). The server runs at most two at once, so a flood queues instead of exhausting memory, but your own sign-in waits behind it.

Turn on "Always Use HTTPS" for the zone, so the `Secure` cookie is never offered over http.
