# Services sit under /_/ on the console's hostname, behind effect-pi's sign-in at the edge

Langfuse, SeaweedFS and SearXNG run beside the server and listen on 127.0.0.1 only, so on a deployed host reaching their UIs meant an SSH tunnel. Exposing them as they are would put three more logins on the network, one of them (SearXNG) with none, and SeaweedFS's filer and S3 gateway serve every User's files to anyone who reaches them.

## Decisions

- **One path per Service on the console's hostname**: `/_/langfuse/`, `/_/seaweedfs/`, `/_/searxng/`. `_` folders are private in Next's App Router, so no console page can ever take one, and `/_next/` and `/api/` are unaffected. Every exposure keeps forwarding everything to the edge, and nothing new is needed from DNS, certificates, Tailscale or the tunnel.
- **The edge asks the server before forwarding** (Caddy's `forward_auth` to `GET /api/services/<name>`). The check is an ordinary endpoint behind `Authentication`, with the browser's cookie, Host and Origin copied onto the GET, so `loopbackOnly`, `PUBLIC_URL`, the session and `isolation.test.ts` cover it like any route. A 401 sends the browser to `/login?next=`, which comes back with a full navigation; any other refusal is passed on. The console's session cookie is removed before the request reaches the Service.
- **Not every account**: each Service shows every User's data (Langfuse every trace, SeaweedFS every bucket), which the account isolation otherwise forbids. Only the accounts in `SERVICE_USERS` may open them; unset, only the oldest account, the one setup created. `EDGE_SERVICES` says which Services this host runs; an unlisted one is a 404, and the console's Settings link only to listed ones the caller may open.
- **Each Service keeps its own login** (Langfuse's, SeaweedFS admin's password). The edge's check is the outer gate, not a replacement: neither has a trusted-header sign-in to hand the effect-pi User to.
- **SeaweedFS shows its admin UI only** (`weed admin -urlPrefix=/_/seaweedfs`, with a password). The filer UI writes absolute links and cannot live under a prefix, and the S3 gateway is the data plane: neither goes through the edge.
- **Langfuse is built from source** with `NEXT_PUBLIC_BASE_PATH=/_/langfuse` (`docker/langfuse/edge.yml`), as its docs require: Next.js inlines the base path into the built assets. Its worker stays prebuilt, pinned to the same release. The server's OTLP export keeps going straight to port 3000, under the base path.

## Consequences

- Same origin: a Service's page runs in the console's origin. A script injected into one (Langfuse renders model output) could call the console's API as the person signed in. The cookie being `HttpOnly` and absent from the Service's requests limits what it reads, not what it can ask for. The accounts allowed are the operator's, and the Services are ones they chose to run.
- Langfuse's `NEXTAUTH_URL` names one origin, so its sign-in works through one `PUBLIC_URL` (the https one, when there is one); a `NEXTAUTH_URL` with https sets `Secure` cookies a plain-http LAN URL cannot keep.
- Deploy only: `pnpm dev` has no edge, so nothing serves `/_/`; `EDGE_SERVICES` stays unset there.

## Rejected

- **A subdomain per Service** (`langfuse.pi.example.com`): a separate origin, so no shared-origin risk, and no base-path builds. But each exposure needs a name per Service (a certificate and a CNAME per tunnel hostname, no MagicDNS subdomains on Tailscale, a name per Service on the LAN), and the session cookie would need a parent `Domain`, sending it to every subdomain.
- **Opening the Services to every signed-in account**: simplest, but it hands every User every other User's traces and files.
- **The filer UI with Caddy rewriting its links**: needs a response-body plugin, and the filer has no sign-in of its own.
