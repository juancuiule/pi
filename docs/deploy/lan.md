# Running on a machine in the local network

The same containers as the Raspberry Pi deploy (`docs/deploy/raspberry-pi.md`), with Caddy in place of the Cloudflare Tunnel: Caddy listens on the LAN (and on a VPN such as Tailscale), the server and the console still listen on 127.0.0.1 only.

```
browser on the LAN ──http──> Caddy :80 on the host
                              ├── /api/conversations/*/(shell|desktop) ──> server :4000 (WebSockets)
                              └── everything else ───────────> console :3001 ──/api──> server :4000
```

Traffic is plain http: anyone on the network can read sessions and conversations in transit. Use it on a network you trust; for anything else, use the tunnel.

## Configure

`.env` at the repository root (see `.env.schema` for every variable):

```sh
# Every address people type, comma-separated: the LAN IP, the Tailscale short name and IP over http, and the
# Tailscale full name over https (see "HTTPS on the tailnet"). Requests naming any host left out here are 403.
PUBLIC_URL=http://192.168.1.38,http://debian,http://100.89.34.120,https://debian.tailf8ca0e.ts.net
# Ollama on the same machine: the server container uses the host's network, so 127.0.0.1 reaches it
MODEL_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
MODEL_ID=qwen2.5:3b
# Needed when the host runs Tailscale: its resolv.conf names 100.100.100.100, which containers cannot reach
SANDBOX_DNS=1.1.1.1,8.8.8.8
```

Give the machine a DHCP reservation, so its LAN address stays in `PUBLIC_URL`. A `LAN_PORT` other than 80 goes in every URL too (`http://192.168.1.38:8080`).

Caddy listens on every interface, so plain http over Tailscale needs nothing more: devices on the tailnet reach `http://debian` through MagicDNS (`tailscale status --self --json` shows the full name).

### HTTPS on the tailnet

Over plain http the browser withholds what it keeps for secure contexts (the clipboard, for one), even though Tailscale encrypts the traffic. `tailscale serve` gives the machine's full name a real certificate and forwards to Caddy, on the tailnet only (`funnel` would publish it to the internet):

```sh
sudo tailscale set --operator=$USER    # once, so serve needs no sudo afterwards
tailscale serve --bg --https=443 http://127.0.0.1:80
```

It needs HTTPS certificates turned on for the tailnet (admin console, DNS). The full name goes in `PUBLIC_URL` as https only: the server reads which URL a request came through from its host, so one name cannot be both, and the session cookie is `Secure` through it. `tailscale serve reset` turns it off.

`deploy/lan/.env` (read by Compose itself, git-ignored):

```sh
DOCKER_GID=989   # stat -c %g /var/run/docker.sock
LAN_PORT=80
```

An Ollama model without `num_ctx` in its Modelfile is taken to have a 4096-token context, too small for the agent's tools and prompt. Make a variant with a larger one and set `MODEL_ID` to it:

```sh
printf 'FROM qwen2.5:3b\nPARAMETER num_ctx 32768\n' > /tmp/Modelfile
ollama create qwen2.5:3b-32k -f /tmp/Modelfile
```

## Run

```sh
pnpm sandbox:build
docker compose -f deploy/lan/docker-compose.yml build server
docker compose -f deploy/lan/docker-compose.yml up -d server web
docker compose -f deploy/lan/docker-compose.yml exec server node user.ts add <name>
docker compose -f deploy/lan/docker-compose.yml up -d caddy
```

Create the first account before starting Caddy: while no account exists, the setup screen gives it to whoever opens it first. Later accounts come from `user.ts add` the same way.

After a code change, `build server` again and `up -d`. Conversations, accounts and attachments live in the `effect-pi-data` volume, shared with the Pi deploy's project name (`effect-pi`), so run one of the two on a machine, not both.
