// The Services the edge serves beside the console: each at /_/<name>/ on the site's own hostname, behind effect-pi's
// sign-in (deploy/Caddyfile asks GET /api/services/<name> before forwarding, Caddy's forward_auth). Pure: web/ bundles
// it through effect-pi/api. Decisions: docs/adr/0011-services-behind-the-edge.md.

export const SERVICE_NAMES = ["langfuse", "seaweedfs", "searxng"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** The prefix every Service sits under: `_` is a private folder in Next's App Router, never a console route. */
export const SERVICE_PREFIX = "/_";

export interface ServiceInfo {
  readonly label: string;
  /** Where the console links to: the Service's own home under its prefix. */
  readonly path: string;
  readonly description: string;
}

export const SERVICES: Readonly<Record<ServiceName, ServiceInfo>> = {
  langfuse: {
    label: "Langfuse",
    path: `${SERVICE_PREFIX}/langfuse/`,
    description:
      "Traces of every Conversation, every User's. Signs in with its own account too.",
  },
  seaweedfs: {
    label: "SeaweedFS",
    path: `${SERVICE_PREFIX}/seaweedfs/admin`,
    description:
      "The object store's admin: buckets, files and S3 keys of every User. Signs in with its own password too.",
  },
  searxng: {
    label: "SearXNG",
    path: `${SERVICE_PREFIX}/searxng/`,
    description: "The search engine behind web_search.",
  },
};

export const isServiceName = (name: string): name is ServiceName =>
  (SERVICE_NAMES as readonly string[]).includes(name);

/** A comma-separated list (EDGE_SERVICES): each name once, in catalog order; an unknown name throws. */
export const parseServiceNames = (
  value: string | undefined
): readonly ServiceName[] => {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.filter((name) => !isServiceName(name));
  if (unknown.length > 0) {
    throw new Error(
      `EDGE_SERVICES names ${unknown.join(", ")}; the Services are ${SERVICE_NAMES.join(", ")}`
    );
  }
  return SERVICE_NAMES.filter((name) => names.includes(name));
};

/** Which accounts may open the Services: the named ones, or, with no names, the oldest account (setup's). */
export const mayOpenServices = (
  user: { readonly id: string; readonly name: string },
  options: {
    readonly users: readonly string[] | undefined;
    readonly oldest: { readonly id: string } | undefined;
  }
): boolean =>
  options.users === undefined || options.users.length === 0
    ? options.oldest?.id === user.id
    : options.users.includes(user.name);
