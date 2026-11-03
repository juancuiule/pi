// Nextcloud over its standard protocols, as one signed-in account: WebDAV for files, CalDAV for calendars, CardDAV
// for contacts, OCS for shares and the account itself. Every request goes to the one configured instance (the
// operator's NEXTCLOUD_URL; paths come from the model, hosts never do), carries the app password as Basic auth, and
// follows no redirect, so the credential cannot be carried anywhere else. Error messages never include it.
import { ConnectorError } from "../connectors/connector.ts";
import type { ConnectorCredential } from "../connectors/vault.ts";
import { parseEvents, utcStamp } from "./calendar.ts";
import type { CalendarEvent } from "./calendar.ts";
import { parseContacts } from "./contacts.ts";
import type { Contact } from "./contacts.ts";
import { escapeXml, find, multistatus, textOf } from "./xml.ts";
import type { DavResponse } from "./xml.ts";

export type Fetch = (request: Request) => Promise<Response>;

export interface NextcloudOptions {
  /** The instance's base URL, e.g. `http://127.0.0.1:8180` or `https://cloud.example.com/nextcloud`. */
  readonly url: string;
  /** Each request is cut off after this long; 30 seconds by default. */
  readonly timeoutMs?: number | undefined;
  /** Replaces `fetch`; tests pass an in-process fake Nextcloud. */
  readonly fetch?: Fetch | undefined;
}

/** A request Nextcloud answered with an error status; `message` is for the model or the person. */
export class NextcloudError extends ConnectorError {
  override readonly name: string = "NextcloudError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const USER_AGENT = "effect-pi";
const DEFAULT_TIMEOUT_MS = 30_000;

export const basicAuth = (login: string, password: string): string =>
  `Basic ${Buffer.from(`${login}:${password}`, "utf-8").toString("base64")}`;

/** The instance's base: origin plus path prefix, without a trailing slash. */
const baseOf = (url: string): string => url.replace(/\/+$/u, "");

/**
 * A path in the person's files as clean segments: `/Documents/a.md` → `["Documents", "a.md"]`. `.`/`..` segments and
 * control characters are refused, so a path cannot climb out of the files root.
 */
export const pathSegments = (path: string): string[] => {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "");
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
      /[\u0000-\u001F\u007F]/u.test(segment)
    ) {
      throw new NextcloudError(400, `Not a usable path: ${path}`);
    }
  }
  return segments;
};

const encodePath = (segments: readonly string[]): string =>
  segments.map((segment) => encodeURIComponent(segment)).join("/");

/** `/a/b` for display. */
export const displayPath = (segments: readonly string[]): string =>
  `/${segments.join("/")}`;

const statusMessage = (status: number, what: string): string => {
  switch (status) {
    case 401: {
      return "Nextcloud refused the stored credentials (the app password may have been revoked). The person must reconnect Nextcloud under Settings → Connections.";
    }
    case 403: {
      return `Nextcloud does not allow this: ${what}.`;
    }
    case 404: {
      return `Not found in Nextcloud: ${what}.`;
    }
    case 405:
    case 412: {
      return `It already exists in Nextcloud: ${what}.`;
    }
    case 409: {
      return `The parent folder does not exist in Nextcloud: ${what}.`;
    }
    case 423: {
      return `It is locked in Nextcloud: ${what}.`;
    }
    case 507: {
      return "The person's Nextcloud storage is full.";
    }
    default: {
      return `Nextcloud answered ${status} for ${what}.`;
    }
  }
};

export interface FileEntry {
  /** From the files root: `/Documents/a.md`; a folder's ends without a slash. */
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly size?: number;
  readonly modified?: string;
  readonly contentType?: string;
  readonly fileId?: string;
}

export interface CalendarInfo {
  /** The URL segment: `personal`. */
  readonly id: string;
  readonly name: string;
  readonly components: readonly string[];
}

export interface AddressBookInfo {
  readonly id: string;
  readonly name: string;
}

export interface Share {
  readonly id: string;
  readonly type: "user" | "group" | "link" | "email" | "federated" | "other";
  readonly path: string;
  readonly with?: string;
  readonly permissions: readonly string[];
  readonly url?: string;
  readonly expiration?: string;
  readonly note?: string;
}

const SHARE_TYPES: Record<number, Share["type"]> = {
  0: "user",
  1: "group",
  3: "link",
  4: "email",
  6: "federated",
};

const PERMISSION_BITS: readonly [number, string][] = [
  [1, "read"],
  [2, "update"],
  [4, "create"],
  [8, "delete"],
  [16, "share"],
];

// Each bit is a power of two: it is set when the quotient's lowest binary digit is 1.
const permissionsOf = (bits: number): string[] =>
  PERMISSION_BITS.filter(([bit]) => Math.floor(bits / bit) % 2 === 1).map(
    ([, name]) => name
  );

/** The model's `read` or `edit` as OCS permission bits; `edit` on a folder also allows creating and deleting. */
export const permissionBits = (
  permission: "read" | "edit",
  folder: boolean
): number => {
  if (permission === "read") {
    return 1;
  }
  return folder ? 15 : 3;
};

interface OcsEnvelope {
  readonly ocs?: {
    readonly meta?: { readonly statuscode?: number; readonly message?: string };
    readonly data?: unknown;
  };
}

/** The low-level transport: one request to the instance, with the timeout and no redirects. */
const transport = (options: NextcloudOptions) => {
  const base = baseOf(options.url);
  const doFetch: Fetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (
    method: string,
    path: string,
    init: {
      readonly authorization?: string;
      readonly headers?: Record<string, string>;
      readonly body?: string | Uint8Array;
      readonly signal?: AbortSignal | undefined;
    } = {}
  ): Promise<Response> => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init.signal !== undefined) {
      signals.push(init.signal);
    }
    const request = new Request(`${base}${path}`, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        ...(init.authorization === undefined
          ? {}
          : { Authorization: init.authorization }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    let response: Response;
    try {
      response = await doFetch(request);
    } catch (error) {
      if (init.signal?.aborted === true) {
        throw error;
      }
      throw new NextcloudError(
        0,
        error instanceof Error && error.name === "TimeoutError"
          ? "Nextcloud did not answer in time."
          : "Nextcloud could not be reached."
      );
    }
    // A redirect would carry the credential to wherever it points; none of these endpoints redirects.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new NextcloudError(
        response.status,
        "Nextcloud answered with a redirect; check NEXTCLOUD_URL (its scheme, host and path)."
      );
    }
    return response;
  };
};

const ocsHeaders = {
  "OCS-APIRequest": "true",
  Accept: "application/json",
};

/** The `ocs.data` of a successful OCS response; throws `NextcloudError` otherwise. */
const ocsData = async (response: Response, what: string): Promise<unknown> => {
  const text = await response.text();
  let envelope: OcsEnvelope | undefined;
  try {
    envelope = JSON.parse(text) as OcsEnvelope;
  } catch {
    envelope = undefined;
  }
  const code = envelope?.ocs?.meta?.statuscode ?? response.status;
  if (!response.ok || (code !== 200 && code !== 100)) {
    const message = envelope?.ocs?.meta?.message;
    throw new NextcloudError(
      response.status === 200 ? code : response.status,
      message === undefined || message === "" || response.status === 401
        ? statusMessage(response.status === 200 ? code : response.status, what)
        : `Nextcloud: ${message}`
    );
  }
  return envelope?.ocs?.data;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" ? String(value) : undefined;
};

/** Who a credential signs in as, from OCS `cloud/user`. */
export const fetchAccount = async (
  options: NextcloudOptions,
  login: string,
  password: string,
  signal?: AbortSignal
): Promise<{ readonly id: string; readonly displayName: string }> => {
  const send = transport(options);
  const response = await send("GET", "/ocs/v2.php/cloud/user?format=json", {
    authorization: basicAuth(login, password),
    headers: ocsHeaders,
    signal,
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new NextcloudError(401, "Nextcloud refused this login and password.");
  }
  const data = asRecord(await ocsData(response, "the account"));
  const id = asString(data.id) ?? login;
  return { id, displayName: asString(data.displayname) ?? id };
};

/**
 * Exchange a regular password for an app password (`core/getapppassword`), so the person's own password is never
 * stored. `undefined` when `password` already is an app password (Nextcloud answers 403 then).
 */
export const exchangeAppPassword = async (
  options: NextcloudOptions,
  login: string,
  password: string,
  signal?: AbortSignal
): Promise<string | undefined> => {
  const send = transport(options);
  const response = await send(
    "GET",
    "/ocs/v2.php/core/getapppassword?format=json",
    {
      authorization: basicAuth(login, password),
      headers: ocsHeaders,
      signal,
    }
  );
  if (response.status === 403) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new NextcloudError(401, "Nextcloud refused this login and password.");
  }
  const data = asRecord(await ocsData(response, "an app password"));
  const appPassword = asString(data.apppassword);
  if (appPassword === undefined) {
    throw new NextcloudError(500, "Nextcloud returned no app password.");
  }
  return appPassword;
};

/** Delete the app password at Nextcloud (`DELETE core/apppassword`). */
export const revokeAppPassword = async (
  options: NextcloudOptions,
  credential: ConnectorCredential
): Promise<void> => {
  const send = transport(options);
  const response = await send(
    "DELETE",
    "/ocs/v2.php/core/apppassword?format=json",
    {
      authorization: basicAuth(credential.account.login, credential.secret),
      headers: ocsHeaders,
    }
  );
  await response.body?.cancel();
};

/** Login Flow v2: the URL the person opens and the token the server polls with. */
export const startLoginFlow = async (
  options: NextcloudOptions,
  signal?: AbortSignal
): Promise<{ readonly loginUrl: string; readonly token: string }> => {
  const send = transport(options);
  const response = await send("POST", "/index.php/login/v2", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new NextcloudError(
      response.status,
      statusMessage(response.status, "the login flow")
    );
  }
  const body = asRecord(await response.json());
  const poll = asRecord(body.poll);
  const loginUrl = asString(body.login);
  const token = asString(poll.token);
  if (loginUrl === undefined || token === undefined) {
    throw new NextcloudError(
      500,
      "Nextcloud's login flow answered without a login URL."
    );
  }
  return { loginUrl, token };
};

/**
 * One poll of a Login Flow v2: the login name and app password once the person granted access, `undefined` while
 * they have not. Always polls the configured instance, never the endpoint Nextcloud names.
 */
export const pollLoginFlow = async (
  options: NextcloudOptions,
  token: string,
  signal?: AbortSignal
): Promise<
  { readonly login: string; readonly appPassword: string } | undefined
> => {
  const send = transport(options);
  const response = await send("POST", "/index.php/login/v2/poll", {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }).toString(),
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new NextcloudError(
      response.status,
      statusMessage(response.status, "the login flow")
    );
  }
  const body = asRecord(await response.json());
  const login = asString(body.loginName);
  const appPassword = asString(body.appPassword);
  if (login === undefined || appPassword === undefined) {
    throw new NextcloudError(
      500,
      "Nextcloud's login flow answered without an app password."
    );
  }
  return { login, appPassword };
};

const FILE_PROPS = `<d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><oc:size/><oc:fileid/>`;

/** A share as OCS describes it. */
const shareOf = (raw: unknown): Share => {
  const record = asRecord(raw);
  const type = SHARE_TYPES[Number(record.share_type)] ?? "other";
  const withWhom =
    asString(record.share_with_displayname) ?? asString(record.share_with);
  const url = asString(record.url);
  const expiration = asString(record.expiration);
  const note = asString(record.note);
  return {
    id: asString(record.id) ?? "",
    type,
    path: asString(record.path) ?? "",
    ...(withWhom === undefined || withWhom === "" || type === "link"
      ? {}
      : { with: withWhom }),
    permissions: permissionsOf(Number(record.permissions ?? 0)),
    ...(url === undefined || url === "" ? {} : { url }),
    ...(expiration === undefined || expiration === ""
      ? {}
      : { expiration: expiration.slice(0, 10) }),
    ...(note === undefined || note === "" ? {} : { note }),
  };
};

/** Folders sort before files: -1 for a folder against a file, 1 for a file against a folder. */
const folderFirst = (entry: FileEntry): number =>
  entry.kind === "folder" ? -1 : 1;

/** At most this much of a file is downloaded for reading. */
export const MAX_READ_BYTES = 10 * 1024 * 1024;

/** The account's view of the instance: every method is one or a few requests, signed as the credential. */
export const nextcloudClient = (
  options: NextcloudOptions,
  credential: ConnectorCredential
) => {
  const send = transport(options);
  const base = baseOf(options.url);
  const basePath = new URL(`${base}/`).pathname.replace(/\/$/u, "");
  const authorization = basicAuth(credential.account.login, credential.secret);
  const user = encodeURIComponent(credential.account.id);
  const filesRoot = `/remote.php/dav/files/${user}`;
  const calendarsRoot = `/remote.php/dav/calendars/${user}`;
  const booksRoot = `/remote.php/dav/addressbooks/users/${user}`;

  const request = async (
    method: string,
    path: string,
    what: string,
    init: {
      readonly headers?: Record<string, string>;
      readonly body?: string | Uint8Array;
      readonly signal?: AbortSignal | undefined;
      readonly ok?: readonly number[];
    } = {}
  ): Promise<Response> => {
    const response = await send(method, path, {
      authorization,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: init.signal,
    });
    if (!response.ok && !(init.ok ?? []).includes(response.status)) {
      await response.body?.cancel();
      throw new NextcloudError(
        response.status,
        statusMessage(response.status, what)
      );
    }
    return response;
  };

  const dav = async (
    method: "PROPFIND" | "REPORT" | "SEARCH",
    path: string,
    what: string,
    body: string,
    depth: "0" | "1" | "infinity",
    signal?: AbortSignal
  ): Promise<DavResponse[]> => {
    const response = await request(method, path, what, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
      },
      body: `<?xml version="1.0" encoding="utf-8"?>${body}`,
      signal,
    });
    return multistatus(await response.text());
  };

  /** A DAV href as a path below `root`, decoded segments; `undefined` when it is not below it. */
  const below = (href: string, root: string): string[] | undefined => {
    let pathname: string;
    try {
      ({ pathname } = new URL(href, `${base}/`));
    } catch {
      return undefined;
    }
    const prefix = `${basePath}${root}`;
    if (!pathname.startsWith(prefix)) {
      return undefined;
    }
    return pathname
      .slice(prefix.length)
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
  };

  const fileEntry = (response: DavResponse): FileEntry | undefined => {
    const segments = below(response.href, filesRoot);
    if (segments === undefined) {
      return undefined;
    }
    const folder = find(response.props, "collection") !== undefined;
    const size = Number(
      textOf(response.props, folder ? "size" : "getcontentlength") ?? Number.NaN
    );
    const modified = textOf(response.props, "getlastmodified");
    const contentType = textOf(response.props, "getcontenttype");
    const fileId = textOf(response.props, "fileid");
    return {
      path: displayPath(segments),
      kind: folder ? "folder" : "file",
      ...(Number.isFinite(size) ? { size } : {}),
      ...(modified === undefined || modified === ""
        ? {}
        : { modified: new Date(modified).toISOString() }),
      ...(folder || contentType === undefined || contentType === ""
        ? {}
        : { contentType }),
      ...(fileId === undefined || fileId === "" ? {} : { fileId }),
    };
  };

  const filePath = (path: string) =>
    `${filesRoot}/${encodePath(pathSegments(path))}`;

  const collections = async (
    root: string,
    kind: "calendar" | "addressbook",
    signal?: AbortSignal
  ) => {
    const body =
      kind === "calendar"
        ? `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`
        : `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`;
    const responses = await dav(
      "PROPFIND",
      `${root}/`,
      kind === "calendar" ? "the calendars" : "the address books",
      body,
      "1",
      signal
    );
    return responses.flatMap((response) => {
      const segments = below(response.href, root);
      const resourceType = find(response.props, "resourcetype");
      if (
        segments?.length !== 1 ||
        resourceType === undefined ||
        find(resourceType, kind) === undefined
      ) {
        return [];
      }
      const id = segments[0] ?? "";
      const name = textOf(response.props, "displayname");
      const set = find(response.props, "supported-calendar-component-set");
      return [
        {
          id,
          name: name === undefined || name === "" ? id : name,
          href: response.href,
          components:
            set === undefined
              ? []
              : set.children
                  .filter((child) => child.name === "comp")
                  .map((child) => (child.attributes.name ?? "").toUpperCase()),
        },
      ];
    });
  };

  const ocs = async (
    method: string,
    path: string,
    what: string,
    params?: URLSearchParams,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const query =
      method === "GET" && params !== undefined ? `&${params.toString()}` : "";
    const response = await send(
      method,
      `/ocs/v2.php/apps/files_sharing/api/v1/${path}?format=json${query}`,
      {
        authorization,
        headers: {
          ...ocsHeaders,
          ...(method === "GET" || params === undefined
            ? {}
            : { "Content-Type": "application/x-www-form-urlencoded" }),
        },
        ...(method === "GET" || params === undefined
          ? {}
          : { body: params.toString() }),
        signal,
      }
    );
    return ocsData(response, what);
  };

  return {
    files: {
      /** A folder's entries (depth 1), or the entry itself for a file. */
      list: async (
        path: string,
        signal?: AbortSignal
      ): Promise<{
        readonly self: FileEntry | undefined;
        readonly entries: FileEntry[];
      }> => {
        const segments = pathSegments(path);
        const responses = await dav(
          "PROPFIND",
          `${filesRoot}/${encodePath(segments)}`,
          displayPath(segments),
          `<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>${FILE_PROPS}</d:prop></d:propfind>`,
          "1",
          signal
        );
        const all = responses.flatMap((response) => {
          const entry = fileEntry(response);
          return entry === undefined ? [] : [entry];
        });
        const own = displayPath(segments);
        const self = all.find((entry) => entry.path === own);
        const entries = all
          .filter((entry) => entry.path !== own)
          .toSorted((a, b) =>
            a.kind === b.kind ? a.path.localeCompare(b.path) : folderFirst(a)
          );
        return { self, entries };
      },
      /** A file's bytes, at most `MAX_READ_BYTES`, and its type. */
      read: async (
        path: string,
        signal?: AbortSignal
      ): Promise<{
        readonly bytes: Uint8Array;
        readonly contentType: string;
        readonly size: number;
        readonly truncated: boolean;
      }> => {
        const response = await request(
          "GET",
          filePath(path),
          displayPath(pathSegments(path)),
          { signal }
        );
        const size = Number(
          response.headers.get("content-length") ?? Number.NaN
        );
        const contentType =
          response.headers.get("content-type") ?? "application/octet-stream";
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        if (reader !== undefined) {
          for (;;) {
            // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            chunks.push(value);
            total += value.byteLength;
            if (total > MAX_READ_BYTES) {
              truncated = true;
              // oxlint-disable-next-line no-await-in-loop -- stops the download once, then the loop ends
              await reader.cancel();
              break;
            }
          }
        }
        const bytes = Buffer.concat(chunks).subarray(0, MAX_READ_BYTES);
        return {
          bytes,
          contentType,
          size: Number.isFinite(size) ? size : total,
          truncated,
        };
      },
      /** Files and folders whose name contains `query`, below `path`. */
      search: async (
        query: string,
        path: string,
        limit: number,
        signal?: AbortSignal
      ): Promise<FileEntry[]> => {
        const scope =
          `/files/${user}/${encodePath(pathSegments(path))}`.replace(
            /\/$/u,
            ""
          );
        const pattern = `%${query.replaceAll("%", "").replaceAll("_", "")}%`;
        const responses = await dav(
          "SEARCH",
          "/remote.php/dav/",
          "the search",
          `<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:basicsearch><d:select><d:prop>${FILE_PROPS}</d:prop></d:select><d:from><d:scope><d:href>${escapeXml(decodeURIComponent(scope))}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>${escapeXml(pattern)}</d:literal></d:like></d:where><d:orderby/><d:limit><d:nresults>${limit}</d:nresults></d:limit></d:basicsearch></d:searchrequest>`,
          "infinity",
          signal
        );
        return responses
          .flatMap((response) => {
            const entry = fileEntry(response);
            return entry === undefined ? [] : [entry];
          })
          .slice(0, limit);
      },
      /** Write a file; `created` tells a new file from a replaced one. */
      write: async (
        path: string,
        content: string,
        overwrite: boolean,
        signal?: AbortSignal
      ): Promise<"created" | "replaced"> => {
        const response = await request(
          "PUT",
          filePath(path),
          displayPath(pathSegments(path)),
          {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...(overwrite ? {} : { "If-None-Match": "*" }),
            },
            body: content,
            signal,
          }
        );
        await response.body?.cancel();
        return response.status === 201 ? "created" : "replaced";
      },
      mkdir: async (path: string, signal?: AbortSignal): Promise<void> => {
        const response = await request(
          "MKCOL",
          filePath(path),
          displayPath(pathSegments(path)),
          { signal }
        );
        await response.body?.cancel();
      },
      /** Move or copy; the destination must not exist unless `overwrite`. */
      move: async (
        from: string,
        to: string,
        mode: { readonly copy: boolean; readonly overwrite: boolean },
        signal?: AbortSignal
      ): Promise<void> => {
        const destination = `${base}${filePath(to)}`;
        const response = await request(
          mode.copy ? "COPY" : "MOVE",
          filePath(from),
          `${displayPath(pathSegments(from))} → ${displayPath(pathSegments(to))}`,
          {
            headers: {
              Destination: destination,
              Overwrite: mode.overwrite ? "T" : "F",
            },
            signal,
          }
        );
        await response.body?.cancel();
      },
      /** Delete a file or folder (Nextcloud keeps it in its trash bin). */
      remove: async (path: string, signal?: AbortSignal): Promise<void> => {
        const segments = pathSegments(path);
        if (segments.length === 0) {
          throw new NextcloudError(
            400,
            "Refusing to delete the root of the files."
          );
        }
        const response = await request(
          "DELETE",
          filePath(path),
          displayPath(segments),
          { signal }
        );
        await response.body?.cancel();
      },
    },

    calendars: async (signal?: AbortSignal): Promise<CalendarInfo[]> => {
      const found = await collections(calendarsRoot, "calendar", signal);
      return found.map(({ id, name, components }) => ({
        id,
        name,
        components,
      }));
    },

    /** Events between `from` and `to` in the given calendars, recurring ones expanded, soonest first. */
    events: async (
      calendarIds: readonly string[],
      from: Date,
      to: Date,
      signal?: AbortSignal
    ): Promise<(CalendarEvent & { readonly calendar: string })[]> => {
      const start = utcStamp(from);
      const end = utcStamp(to);
      const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
      const perCalendar = await Promise.all(
        calendarIds.map(async (calendar) => {
          const responses = await dav(
            "REPORT",
            `${calendarsRoot}/${encodeURIComponent(calendar)}/`,
            `calendar ${calendar}`,
            body,
            "1",
            signal
          );
          return responses.flatMap((response) =>
            parseEvents(textOf(response.props, "calendar-data") ?? "").map(
              (event) => ({ ...event, calendar })
            )
          );
        })
      );
      return perCalendar
        .flat()
        .toSorted((a, b) => a.start.localeCompare(b.start));
    },

    createEvent: async (
      calendar: string,
      uid: string,
      ics: string,
      signal?: AbortSignal
    ): Promise<void> => {
      const response = await request(
        "PUT",
        `${calendarsRoot}/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`,
        `calendar ${calendar}`,
        {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "If-None-Match": "*",
          },
          body: ics,
          signal,
        }
      );
      await response.body?.cancel();
    },

    /** Delete the calendar object holding event `uid` (all its instances); false when there is none. */
    deleteEvent: async (
      calendar: string,
      uid: string,
      signal?: AbortSignal
    ): Promise<boolean> => {
      const root = `${calendarsRoot}/${encodeURIComponent(calendar)}/`;
      const responses = await dav(
        "REPORT",
        root,
        `calendar ${calendar}`,
        `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        "1",
        signal
      );
      const href = responses.find((response) =>
        response.href.endsWith(".ics")
      )?.href;
      if (href === undefined) {
        return false;
      }
      const pathname = new URL(href, `${base}/`).pathname.slice(
        basePath.length
      );
      const response = await request("DELETE", pathname, `event ${uid}`, {
        signal,
      });
      await response.body?.cancel();
      return true;
    },

    addressBooks: async (signal?: AbortSignal): Promise<AddressBookInfo[]> => {
      const books = await collections(booksRoot, "addressbook", signal);
      return books.map(({ id, name }) => ({ id, name }));
    },

    /** Contacts whose name, email, phone or organization contains `query` (all with an empty one), at most `limit`. */
    contacts: async (
      bookIds: readonly string[],
      query: string,
      limit: number,
      signal?: AbortSignal
    ): Promise<(Contact & { readonly addressBook: string })[]> => {
      const match = (name: string) =>
        `<card:prop-filter name="${name}"><card:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(query)}</card:text-match></card:prop-filter>`;
      const filter =
        query.trim() === ""
          ? `<card:filter/>`
          : `<card:filter test="anyof">${["FN", "EMAIL", "TEL", "ORG"].map(match).join("")}</card:filter>`;
      const body = `<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop>${filter}<card:limit><card:nresults>${limit}</card:nresults></card:limit></card:addressbook-query>`;
      const perBook = await Promise.all(
        bookIds.map(async (book) => {
          const responses = await dav(
            "REPORT",
            `${booksRoot}/${encodeURIComponent(book)}/`,
            `address book ${book}`,
            body,
            "1",
            signal
          );
          return responses.flatMap((response) =>
            parseContacts(textOf(response.props, "address-data") ?? "").map(
              (contact) => ({ ...contact, addressBook: book })
            )
          );
        })
      );
      return perBook
        .flat()
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit);
    },

    createContact: async (
      book: string,
      uid: string,
      vcf: string,
      signal?: AbortSignal
    ): Promise<void> => {
      const response = await request(
        "PUT",
        `${booksRoot}/${encodeURIComponent(book)}/${encodeURIComponent(uid)}.vcf`,
        `address book ${book}`,
        {
          headers: {
            "Content-Type": "text/vcard; charset=utf-8",
            "If-None-Match": "*",
          },
          body: vcf,
          signal,
        }
      );
      await response.body?.cancel();
    },

    /** The account's shares, or those of one path. */
    shares: async (
      path: string | undefined,
      signal?: AbortSignal
    ): Promise<Share[]> => {
      const params = new URLSearchParams();
      if (path !== undefined) {
        params.set("path", displayPath(pathSegments(path)));
      }
      const data = await ocs(
        "GET",
        "shares",
        path === undefined ? "the shares" : displayPath(pathSegments(path)),
        params,
        signal
      );
      return (Array.isArray(data) ? data : []).map(shareOf);
    },

    createShare: async (
      input: {
        readonly path: string;
        readonly type: "link" | "user" | "group" | "email";
        readonly with?: string | undefined;
        readonly permissions: number;
        readonly expireDate?: string | undefined;
        readonly password?: string | undefined;
        readonly note?: string | undefined;
      },
      signal?: AbortSignal
    ): Promise<Share> => {
      const params = new URLSearchParams({
        path: displayPath(pathSegments(input.path)),
        shareType: String({ user: 0, group: 1, link: 3, email: 4 }[input.type]),
        permissions: String(input.permissions),
      });
      if (input.with !== undefined) {
        params.set("shareWith", input.with);
      }
      if (input.expireDate !== undefined) {
        params.set("expireDate", input.expireDate);
      }
      if (input.password !== undefined) {
        params.set("password", input.password);
      }
      if (input.note !== undefined) {
        params.set("note", input.note);
      }
      return shareOf(
        await ocs(
          "POST",
          "shares",
          displayPath(pathSegments(input.path)),
          params,
          signal
        )
      );
    },

    deleteShare: async (id: string, signal?: AbortSignal): Promise<void> => {
      await ocs(
        "DELETE",
        `shares/${encodeURIComponent(id)}`,
        `share ${id}`,
        undefined,
        signal
      );
    },
  };
};

export type NextcloudClient = ReturnType<typeof nextcloudClient>;
