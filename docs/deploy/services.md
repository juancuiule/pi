# Services

Langfuse, SeaweedFS and SearXNG run beside the server, on the host's 127.0.0.1. The edge can serve their UIs on the site's own hostname, each under a path, to the accounts allowed to open them:

| Service | Path | Runs with | Its own login |
| --- | --- | --- | --- |
| `langfuse` | `/_/langfuse/` | `pnpm langfuse:edge <url>`, then `pnpm langfuse:up` | yes |
| `seaweedfs` | `/_/seaweedfs/admin` | `pnpm seaweed:up` | `admin`, `SEAWEEDFS_ADMIN_PASSWORD` in `docker/seaweedfs/.env` |
| `searxng` | `/_/searxng/` | `pnpm searxng:up` | none |

Every request under `/_/<name>/` first goes to the server (`GET /api/services/<name>`, Caddy's `forward_auth`) with the browser's cookie. Signed out, the browser is sent to sign in and comes back; signed in with an account that may not open the Services, the answer is 403. The console's session cookie never reaches the Service. Why it works this way: [ADR-0011](../adr/0011-services-behind-the-edge.md).

## Configure

In the repository's `.env`:

```sh
EDGE_SERVICES=langfuse,seaweedfs,searxng   # the ones this host runs
SERVICE_USERS=alice                         # optional; unset, only the oldest account (setup's)
```

Each Service shows every account's data (Langfuse every trace, SeaweedFS every bucket), so they are not for every account. Settings in the console lists the Services the signed-in account may open. Then run `deploy/deploy.sh`: it checks that each listed Service sends a signed-out browser to sign in.

Without the edge (`pnpm dev`), nothing serves `/_/`: leave `EDGE_SERVICES` unset and open the Services on their loopback ports.

## Langfuse

Langfuse is a Next.js app, which builds its base path into its assets: under `/_/langfuse/` it needs its web image built from source (`docker/langfuse/edge.yml`, Langfuse's [custom base path](https://langfuse.com/self-hosting/configuration/custom-base-path)). Once:

```sh
pnpm langfuse:edge https://pi.example.com   # the PUBLIC_URL people sign in to Langfuse through
pnpm langfuse:up                            # the first run builds the image (long, several GB of memory)
```

`langfuse:edge` sets three lines: `COMPOSE_FILE` and `NEXTAUTH_URL` (`https://pi.example.com/_/langfuse/api/auth`) in `docker/langfuse/.env`, and `LANGFUSE_BASE_URL=http://localhost:3000/_/langfuse` in `.env`. Every Langfuse route moves under the base path on port 3000 too, so the server's traces still go straight there, not through the edge. Restart the server afterwards. `pnpm langfuse:edge off` goes back to the prebuilt image at `http://localhost:3000`.

- Sign-in works through the one origin in `NEXTAUTH_URL`. Choose the https one: with https, Langfuse's cookies are `Secure`, which a plain-http LAN URL cannot keep.
- The web image follows `LANGFUSE_VERSION` (4.72.0 by default), and the worker is pinned to the same release. Set it in `docker/langfuse/.env` to upgrade; the next `pnpm langfuse:up` builds the new image.
- Media in traces loads from MinIO on the host's `localhost:9090`, which only the host's own browser reaches.

## SeaweedFS

Only the admin UI (`weed admin`, the `admin` service in `docker/seaweedfs/docker-compose.yml`, run with `-urlPrefix=/_/seaweedfs`): cluster, volumes, buckets and files, and S3 keys. It signs in as `admin` with the password `pnpm seaweed:up` writes to `docker/seaweedfs/.env`. The filer UI (8888) and the S3 gateway (8333) stay on loopback: the filer's links do not work under a prefix, and the gateway is the data plane. The admin's links to the master, volume and filer UIs name container addresses and do not open remotely.

## SearXNG

The search page, mounted under `/_/searxng/` by the `X-Script-Name` header the edge sends. The server's `web_search` keeps calling `SEARXNG_URL` directly.
