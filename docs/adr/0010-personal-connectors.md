# Personal connectors: host tools over each User's own sealed credential, gated by read or write

Nextcloud (#80) is the first service the agent works in on a person's behalf; OpenProject (#81) and Google Calendar (#83) follow. Each needs the same two things the MCP plumbing (`src/mcp.ts`) lacks: a credential per User, and the product's approval split. A **Connection** is one User's account on one such service (the term is in `GLOSSARY.md`); a personal connector (`PersonalConnector`, `src/connectors/connector.ts`) is the code that offers it.

## Decisions

- **Native host tools, not an MCP server.** `src/nextcloud/` speaks WebDAV, CalDAV, CardDAV and OCS itself (16 tools: files, calendars, contacts, shares). The tools run on the host at every Level, like `web_search`.
- **One instance per server.** The operator sets `NEXTCLOUD_URL`; a User supplies only a login and password, never a URL, so no one can point the server's requests at an arbitrary host. Requests follow no redirect, so the credential cannot be carried elsewhere.
- **The conversation's owner signs every call.** A tool resolves the owner through the conversation's root (`conversationOwner`), so a subagent works in its parent's owner's account, and reads that owner's credential on each call: a reconnect or disconnect applies on the next call. Without one the tool fails with "connect it under Settings → Connections", and the prompt section says so up front.
- **Credentials are sealed at rest.** `connector_credentials` in `EFFECT_PI_DB` (owner, connector, account, secret) holds the secret under AES-256-GCM with `CONNECTOR_SECRET_KEY` (`@sensitive`, from `.env`), with owner and connector as associated data: a Litestream replica or a backup carries no usable credential, and a row moved to another User does not open. The key lives beside the database on the host, so this protects copies, not a compromised host. A changed key makes rows unreadable; the console asks those people to connect again (no rotation yet).
- **App passwords only.** Login Flow v2 (the console opens Nextcloud's own grant page and the server polls) gives the server an app password without the person typing anything into the console. The form fallback exchanges a regular password for an app password (`core/getapppassword`) so the person's own password is never stored. Disconnect revokes the app password at Nextcloud.
- **Never to the model, logs or traces.** No endpoint returns a secret; tool arguments and results carry none; error messages are built without the request's headers.
- **Gating is by access, declared where the tool is defined.** `connectorTool("read" | "write", tool)`: reads run under every policy and may replay after a crash; writes go through `withApproval`, so they wait for the person under `ask`. This is the issue's reading of "similar permissions": the split the product already has, not a classifier (#25).
- **Optional.** Without `NEXTCLOUD_URL` there is no connector, no extension, no prompt section and no Settings card, and `CONNECTOR_SECRET_KEY` is not needed. With it, a missing key stops startup.
- **The local instance is a dev service.** `pnpm nextcloud:up` runs Nextcloud 35 and Postgres on 127.0.0.1:8180 and bootstraps an admin and an app password. It is not in `deploy/compose.yml`: a Nextcloud is a stateful product with its own upgrades and backups, and a deployment points `NEXTCLOUD_URL` at one.

## For the next connector

OpenProject and Google Calendar implement `PersonalConnector` (`connect`, optional `startLogin` and `revoke`, `extension`) and get storage, the Settings card, the owner lookup and gating unchanged. A connector backed by an MCP server would open one MCP session per Connection with the credential in its headers and classify each tool's access from `readOnlyHint`, overridable per tool; the credential and gating story stays the same. Google's OAuth refresh tokens fit `secret`; the token refresh is the connector's.

## Considered options

- **Nextcloud's Context Agent** (an ExApp with an MCP endpoint): rejected. It needs AppAPI, HaRP and a deploy daemon with the Docker socket inside Nextcloud, and it is an agent of its own built for Nextcloud Assistant.
- **cbcoutinho/nextcloud-mcp-server** as a sibling container, Streamable HTTP with per-request Basic auth pass-through: rejected for now. Its 110+ tools (Mail, Deck, Cookbook, ...) would crowd the prompt, it receives every User's credential in a Python process we do not maintain, it releases several times a week, and MCP tools carry no reliable read/write marking for gating. Revisit if people want Deck, Notes or Talk.
- **Credentials in `mcp.config.ts` headers from the environment**: one account for the whole server, which breaks ownership.
- **A per-User Nextcloud URL**: lets any User make the server request any host (SSRF), for no need a single household or team has.
- **Unencrypted rows**: the database is replicated off the host by Litestream; app passwords there would be usable by anyone holding a replica.
