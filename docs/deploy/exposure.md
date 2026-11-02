# Exposures

Each exposure forwards to the edge (see [README.md](README.md)) and needs its URLs in `PUBLIC_URL`. Choose them in `deploy/.env` with `EXPOSURE`, then run `deploy/deploy.sh`.

| Exposure | Reaches | `PUBLIC_URL` entries | Transport |
| --- | --- | --- | --- |
| `lan` | devices on your network | `http://<LAN IP>`, and `http://<tailscale short name>` / `http://<tailscale IP>` when Tailscale runs on the host | plain http |
| `tailscale` | your devices on the tailnet, anywhere | `https://<machine>.<tailnet>.ts.net` | https, Tailscale's certificate |
| `cloudflare` | the internet, behind Cloudflare Access | `https://<your hostname>` | https, Cloudflare's certificate |

An https URL makes the session cookie `Secure` for requests that came through it. The server reads which URL a request came through from its host, so one name cannot be both http and https.

## lan

The edge listens on `LAN_PORT` (80 by default) on every interface. A `LAN_PORT` other than 80 goes in every LAN URL too (`http://192.168.1.38:8080`).

Traffic is plain http: anyone on the network can read sessions and conversations in transit. Use it on a network you trust. Give the host a DHCP reservation, so its address stays in `PUBLIC_URL`.

Because the edge listens on every interface, plain http over Tailscale works too, through MagicDNS short names (`http://debian`).

## tailscale

`deploy.sh` runs `tailscale serve --bg --https=443` to the edge, on the tailnet only (`funnel` would publish it to the internet). Over https the browser also allows what it keeps for secure contexts, such as the clipboard.

Once per host:

```sh
sudo tailscale set --operator=$USER    # so serve needs no sudo
```

and turn on HTTPS certificates for the tailnet (admin console, DNS). `tailscale status --self --json` shows the full name. Leaving `tailscale` out of `EXPOSURE` does not turn serve off: run `tailscale serve --https=443 off`.

Tailscale on the host names `100.100.100.100` in its resolv.conf, which containers cannot reach: set `SANDBOX_DNS=1.1.1.1,8.8.8.8` in `.env`.

## cloudflare

A locally managed tunnel: cloudflared runs as a container and forwards everything to the edge with `--url`, so there is no ingress file. Once per host:

```sh
cloudflared tunnel login
cloudflared tunnel create effect-pi                       # -> ~/.cloudflared/<tunnel id>.json
cloudflared tunnel route dns effect-pi pi.example.com     # the CNAME
cp ~/.cloudflared/<tunnel id>.json deploy/.cloudflared/credentials.json
```

Then set `CLOUDFLARE_TUNNEL=<tunnel id>` in `deploy/.env` and `https://pi.example.com` in `PUBLIC_URL`. The credentials file stays mode 600, owned by uid 1000 (cloudflared runs as that user).

A tunnel managed from the dashboard instead has a single public hostname to `http://127.0.0.1:<EDGE_PORT>`. Do not set an HTTP host header override: the server checks the Host header against `PUBLIC_URL`.

### Put Cloudflare Access in front

In Zero Trust, Access, Applications, add a self-hosted application for the hostname with a policy that allows only your email. Then nobody else reaches the sign-in page at all, which matters because:

- sign-in failures are throttled per name, so someone who knows your user name can lock it for up to 15 minutes at a time;
- every sign-in attempt costs a scrypt hash (32 MiB). The server runs at most two at once, so a flood queues instead of exhausting memory, but your own sign-in waits behind it.

Turn on "Always Use HTTPS" for the zone, so the `Secure` cookie is never offered over http.
