# Running on a Raspberry Pi behind a Cloudflare Tunnel

The server listens on 127.0.0.1 only. `cloudflared` runs on the Pi, connects out to Cloudflare, and forwards `https://pi.example.com` to the console on localhost. Nothing listens on the LAN or the internet.

```
browser ──https──> Cloudflare (Access) ──tunnel──> cloudflared on the Pi
                                                    ├── /api/conversations/*/(shell|desktop) ──> server :4000 (WebSockets)
                                                    └── everything else ───────────> console :3001 ──/api──> server :4000
```

## What works remotely

- Every Level: chats, files, the Shell tab, artifacts, attachments, and the desktop. The desktop's VNC stream goes through the server (`/api/conversations/:id/desktop`, behind your session), and the console draws it with its own noVNC.

## Can a Raspberry Pi 4 (8 GB) run a desktop with Chrome?

Yes, one at a time, slowly. What it costs:

- Chrome: Google ships it for arm64 Linux since July 2026 (`google-chrome-stable_current_arm64.deb`, about 430 MB installed); add it as Software on a desktop conversation.
- Memory: XFCE, Xvfb and the VNC server take a few hundred MB; Chrome with a few tabs about 1–1.5 GB. With the server, the console and Docker, one desktop plus a couple of shells fits in 8 GB.
- CPU is the limit, not RAM: Xvfb has no GPU, so Chrome draws everything in software on the Pi 4's four Cortex-A72 cores. Ordinary pages are usable; video, maps and heavy animation are not. Keep the screen small (the image's default 1280x800) and `MAX_DESKTOPS=1`.
- Disk: the desktop image plus Chrome is several GB, and Docker writes a lot. Boot from a USB 3 SSD rather than the SD card.
- Cooling: sustained software rendering throttles a Pi 4 without a heatsink or fan.

## The Pi

- A 64-bit OS (Raspberry Pi OS 64-bit or Ubuntu arm64): the sandbox images are `ubuntu:24.04`, and the pi-env daemon ships an arm64 build. 8 GB of RAM is comfortable; lower `MAX_SHELLS` on smaller boards, and leave desktops off below 8 GB.
- A current Node (the one this repo develops on; `node server.ts` relies on type stripping), pnpm, and Docker Engine with your user in the `docker` group.
- Leave Langfuse and SearXNG off unless you need them; both are heavy for a Pi.

```sh
git clone <this repo> && cd effect-pi
pnpm install
pnpm sandbox:build          # the shell and desktop images, for the Pi's arm64; Chrome is added per conversation
touch .env
```

`.env` (see `.env.schema` for every variable):

```sh
PUBLIC_URL=https://pi.example.com
MAX_DESKTOPS=1
MAX_SHELLS=2
# Each Sandbox's memory (swap included) and CPUs, so an agent's build cannot starve the Pi
SANDBOX_MEMORY_MB=2048
SANDBOX_CPUS=2
# Needed when the Pi runs Tailscale: its resolv.conf names 100.100.100.100, which containers cannot reach
SANDBOX_DNS=1.1.1.1,8.8.8.8
# A model: an API key (Anthropic, Vercel AI Gateway with AI_GATEWAY_API_KEY=vck_..., OpenAI), or Ollama on another machine
ANTHROPIC_API_KEY=sk-ant-...
```

`PUBLIC_URL` makes the server accept requests whose Host or Origin is that URL, beside loopback ones, and marks the session cookie `Secure` for requests that came through it.

## Run with Docker Compose

`deploy/pi/` runs the server, the console and `cloudflared` as containers, the way other services on the same Pi run:

```sh
pnpm sandbox:build                                     # the sandbox images, on the host's Docker
docker compose -f deploy/pi/docker-compose.yml build
docker compose -f deploy/pi/docker-compose.yml up -d server web
docker compose -f deploy/pi/docker-compose.yml exec server node user.ts add <name>
```

- The server gets the host's Docker socket: it starts the Sandboxes as the host's containers, beside it. That socket is root on the host.
- Every service uses the host's network. The server opens each desktop's VNC port, which Docker publishes on the host's 127.0.0.1, and it accepts only loopback hosts or `PUBLIC_URL`; server and console still listen on 127.0.0.1 only.
- Conversations, accounts and attachments live in the `effect-pi-data` volume. `.env` at the repository root is read as `env_file`.
- `deploy/pi/cloudflared/config.yml` is a locally managed tunnel: set `tunnel:` to your tunnel id and copy `~/.cloudflared/<tunnel id>.json` to `deploy/pi/.cloudflared/credentials.json` (git-ignored), then `up -d cloudflared`.

Without Docker, the next section runs the same two processes directly.

## Build and run

Run the production console, not `pnpm dev`: the dev server is slow on a Pi and exposes Next's dev tooling. Both listen on 127.0.0.1 only, like the server; the tunnel is the way in.

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

`~/.cloudflared/config.yml`; the socket rule must come first, because the console's `/api` rewrite cannot carry WebSockets (the Shell tab and the desktop):

```yaml
tunnel: effect-pi
credentials-file: /home/pi/.cloudflared/<tunnel id>.json
ingress:
  - hostname: pi.example.com
    path: ^/api/conversations/[^/]+/(shell|desktop)$
    service: http://localhost:4000
  - hostname: pi.example.com
    service: http://localhost:3001
  - service: http_status:404
```

Do not set `originRequest.httpHostHeader`: the server checks the Host header against `PUBLIC_URL`.

Install it as a service with `sudo cloudflared service install`.

A tunnel managed from the dashboard (Zero Trust → Networks → Tunnels) works too: it runs from a token (`cloudflared tunnel run --token-file ...`), and its public hostnames take the same two routes, in the same order: `pi.example.com` with path `^/api/conversations/[^/]+/(shell|desktop)$` to `http://localhost:4000`, then `pi.example.com` to `http://localhost:3001`. Run `cloudflared` on the host, not in a Docker container: inside a container `localhost` is the container itself (or give the container `network_mode: host`).

## Put Cloudflare Access in front

In Zero Trust → Access → Applications, add a self-hosted application for `pi.example.com` with a policy that allows only your email. Then nobody else reaches the sign-in page at all, which matters because:

- sign-in failures are throttled per name, so someone who knows your user name can lock it for up to 15 minutes at a time;
- every sign-in attempt costs a scrypt hash (32 MiB). The server runs at most two at once, so a flood queues instead of exhausting memory, but your own sign-in waits behind it.

Turn on "Always Use HTTPS" for the zone, so the `Secure` cookie is never offered over http.
