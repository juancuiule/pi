// An in-process fake Nextcloud for tests, answering the requests src/nextcloud/client.ts sends: OCS (account, app
// passwords, shares), Login Flow v2, and enough WebDAV, CalDAV and CardDAV over in-memory maps. Pass `fake.fetch` as
// the connector's `fetch`. Every request is recorded with the login it was signed as.
import { escapeXml } from "../nextcloud/xml.ts";

interface FakeUser {
  readonly id: string;
  readonly login: string;
  readonly password: string;
  readonly displayName: string;
  readonly appPasswords: Set<string>;
  readonly files: Map<string, string | null>;
  readonly events: Map<string, string>;
  readonly contacts: Map<string, string>;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  /** The login the request was signed as, when its credentials were valid. */
  readonly as?: string;
}

const xml = (body: string, status = 207) =>
  new Response(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">${body}</d:multistatus>`,
    { status, headers: { "Content-Type": "application/xml" } }
  );

const ocs = (data: unknown, statuscode = 200, status = 200) =>
  Response.json(
    { ocs: { meta: { status: "ok", statuscode, message: "" }, data } },
    { status }
  );

const response = (href: string, props: string) =>
  `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const encode = (path: string) =>
  path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

export const fakeNextcloud = (
  users: readonly {
    readonly login: string;
    readonly password: string;
    readonly id?: string;
    readonly displayName?: string;
  }[]
) => {
  const accounts = users.map((user): FakeUser => ({
    id: user.id ?? user.login,
    login: user.login,
    password: user.password,
    displayName: user.displayName ?? user.login,
    appPasswords: new Set(),
    files: new Map([["", null]]),
    events: new Map(),
    contacts: new Map(),
  }));
  const requests: FakeRequest[] = [];
  const flows = new Map<string, FakeUser | undefined>();
  const shares = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return counter;
  };

  const authenticate = (
    request: Request
  ): { user: FakeUser; viaApp: boolean } | undefined => {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Basic ")) {
      return undefined;
    }
    const [login, ...rest] = Buffer.from(header.slice(6), "base64")
      .toString("utf-8")
      .split(":");
    const password = rest.join(":");
    const user = accounts.find((account) => account.login === login);
    if (user === undefined) {
      return undefined;
    }
    if (user.appPasswords.has(password)) {
      return { user, viaApp: true };
    }
    return user.password === password ? { user, viaApp: false } : undefined;
  };

  const newAppPassword = (user: FakeUser) => {
    const value = `app-${user.login}-${nextId()}`;
    user.appPasswords.add(value);
    return value;
  };

  const fileProps = (user: FakeUser, path: string) => {
    const content = user.files.get(path);
    const folder = content === null;
    return response(
      `/remote.php/dav/files/${user.id}/${encode(path)}${folder && path !== "" ? "/" : ""}`,
      folder
        ? `<d:resourcetype><d:collection/></d:resourcetype><oc:size>0</oc:size><d:getlastmodified>Tue, 03 Nov 2026 10:00:00 GMT</d:getlastmodified>`
        : `<d:resourcetype/><d:getcontentlength>${Buffer.byteLength(content ?? "")}</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype><d:getlastmodified>Tue, 03 Nov 2026 10:00:00 GMT</d:getlastmodified>`
    );
  };

  // oxlint-disable-next-line complexity -- a fake WebDAV collection: one branch per method
  const files = async (
    request: Request,
    user: FakeUser,
    path: string
  ): Promise<Response> => {
    const exists = user.files.has(path);
    switch (request.method) {
      case "PROPFIND": {
        if (!exists) {
          return new Response(null, { status: 404 });
        }
        const children =
          user.files.get(path) === null
            ? [...user.files.keys()].filter(
                (key) => key !== path && parentOf(key) === path
              )
            : [];
        return xml(
          [path, ...children].map((key) => fileProps(user, key)).join("")
        );
      }
      case "GET": {
        const content = user.files.get(path);
        return content === undefined || content === null
          ? new Response(null, { status: 404 })
          : new Response(content, {
              headers: { "Content-Type": "text/markdown" },
            });
      }
      case "PUT": {
        if (exists && request.headers.get("if-none-match") === "*") {
          return new Response(null, { status: 412 });
        }
        if (user.files.get(parentOf(path)) !== null) {
          return new Response(null, { status: 409 });
        }
        user.files.set(path, await request.text());
        return new Response(null, { status: exists ? 204 : 201 });
      }
      case "MKCOL": {
        if (exists) {
          return new Response(null, { status: 405 });
        }
        user.files.set(path, null);
        return new Response(null, { status: 201 });
      }
      case "DELETE": {
        for (const key of user.files.keys()) {
          if (key === path || key.startsWith(`${path}/`)) {
            user.files.delete(key);
          }
        }
        return new Response(null, { status: exists ? 204 : 404 });
      }
      case "MOVE":
      case "COPY": {
        const destination = new URL(
          request.headers.get("destination") ?? ""
        ).pathname
          .replace(`/remote.php/dav/files/${user.id}/`, "")
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/");
        if (!exists) {
          return new Response(null, { status: 404 });
        }
        if (
          user.files.has(destination) &&
          request.headers.get("overwrite") === "F"
        ) {
          return new Response(null, { status: 412 });
        }
        for (const [key, value] of user.files.entries()) {
          if (key === path || key.startsWith(`${path}/`)) {
            user.files.set(destination + key.slice(path.length), value);
            if (request.method === "MOVE") {
              user.files.delete(key);
            }
          }
        }
        return new Response(null, { status: 201 });
      }
      default: {
        return new Response(null, { status: 405 });
      }
    }
  };

  // oxlint-disable-next-line complexity -- a fake server's router: one branch per route
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const auth = authenticate(request);
    requests.push({
      method: request.method,
      path,
      ...(auth === undefined ? {} : { as: auth.user.login }),
    });

    if (path === "/index.php/login/v2" && request.method === "POST") {
      const token = `token-${nextId()}`;
      flows.set(token, undefined);
      return Response.json({
        poll: { token, endpoint: `${url.origin}/index.php/login/v2/poll` },
        login: `${url.origin}/index.php/login/v2/flow/${token}`,
      });
    }
    if (path === "/index.php/login/v2/poll" && request.method === "POST") {
      const token =
        new URLSearchParams(await request.text()).get("token") ?? "";
      const granted = flows.get(token);
      if (granted === undefined) {
        return new Response("[]", { status: 404 });
      }
      flows.delete(token);
      return Response.json({
        server: url.origin,
        loginName: granted.login,
        appPassword: newAppPassword(granted),
      });
    }

    if (auth === undefined) {
      return new Response(null, { status: 401 });
    }
    const { user } = auth;

    if (path === "/ocs/v2.php/cloud/user") {
      return ocs({ id: user.id, displayname: user.displayName });
    }
    if (path === "/ocs/v2.php/core/getapppassword") {
      return auth.viaApp
        ? ocs([], 403, 403)
        : ocs({ apppassword: newAppPassword(user) });
    }
    if (
      path === "/ocs/v2.php/core/apppassword" &&
      request.method === "DELETE"
    ) {
      const header = request.headers.get("authorization") ?? "";
      const secret = Buffer.from(header.slice(6), "base64")
        .toString("utf-8")
        .split(":")
        .slice(1)
        .join(":");
      user.appPasswords.delete(secret);
      return ocs([]);
    }
    const sharesPrefix = "/ocs/v2.php/apps/files_sharing/api/v1/shares";
    if (path.startsWith(sharesPrefix)) {
      if (request.method === "GET") {
        const only = url.searchParams.get("path");
        return ocs(
          [...shares.values()].filter(
            (share) =>
              share.owner === user.login &&
              (only === null || share.path === only)
          )
        );
      }
      if (request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        const target = (params.get("path") ?? "").replace(/^\//u, "");
        if (!user.files.has(target)) {
          return ocs([], 404, 404);
        }
        const id = String(nextId());
        const type = Number(params.get("shareType"));
        const share = {
          id,
          owner: user.login,
          share_type: type,
          share_with: params.get("shareWith") ?? undefined,
          path: params.get("path"),
          permissions: Number(params.get("permissions")),
          url: type === 3 ? `${url.origin}/s/${id}` : undefined,
          expiration: params.get("expireDate") ?? undefined,
        };
        shares.set(id, share);
        return ocs(share);
      }
      if (request.method === "DELETE") {
        const id = path.slice(sharesPrefix.length + 1);
        return shares.delete(id) ? ocs([]) : ocs([], 404, 404);
      }
    }

    const filesPrefix = `/remote.php/dav/files/${user.id}`;
    if (path.startsWith(filesPrefix)) {
      return files(
        request,
        user,
        path
          .slice(filesPrefix.length)
          .split("/")
          .filter((segment) => segment !== "")
          .map((segment) => decodeURIComponent(segment))
          .join("/")
      );
    }
    if (path === "/remote.php/dav/" && request.method === "SEARCH") {
      const body = await request.text();
      const literal = /<d:literal>%(?<q>.*)%<\/d:literal>/u.exec(body)?.groups
        ?.q;
      const matches = [...user.files.keys()].filter(
        (key) =>
          key !== "" &&
          (key.split("/").at(-1) ?? "")
            .toLowerCase()
            .includes((literal ?? "").toLowerCase())
      );
      return xml(matches.map((key) => fileProps(user, key)).join(""));
    }

    const calendarsPrefix = `/remote.php/dav/calendars/${user.id}/`;
    if (path === calendarsPrefix && request.method === "PROPFIND") {
      return xml(
        response(
          calendarsPrefix,
          `<d:resourcetype><d:collection/></d:resourcetype>`
        ) +
          response(
            `${calendarsPrefix}personal/`,
            `<d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>`
          ) +
          response(
            `${calendarsPrefix}inbox/`,
            `<d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype>`
          )
      );
    }
    if (path.startsWith(`${calendarsPrefix}personal/`)) {
      const name = path.slice(`${calendarsPrefix}personal/`.length);
      if (request.method === "REPORT") {
        const body = await request.text();
        const uid = /<c:text-match[^>]*>(?<uid>[^<]*)</u.exec(body)?.groups
          ?.uid;
        const found = [...user.events.entries()].filter(
          ([, ics]) => uid === undefined || ics.includes(`UID:${uid}`)
        );
        return xml(
          found
            .map(([key, ics]) =>
              response(
                `${calendarsPrefix}personal/${key}`,
                `<d:getetag>"1"</d:getetag><cal:calendar-data>${escapeXml(ics)}</cal:calendar-data>`
              )
            )
            .join("")
        );
      }
      if (request.method === "PUT") {
        user.events.set(name, await request.text());
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        return new Response(null, {
          status: user.events.delete(name) ? 204 : 404,
        });
      }
    }

    const booksPrefix = `/remote.php/dav/addressbooks/users/${user.id}/`;
    if (path === booksPrefix && request.method === "PROPFIND") {
      return xml(
        response(
          booksPrefix,
          `<d:resourcetype><d:collection/></d:resourcetype>`
        ) +
          response(
            `${booksPrefix}contacts/`,
            `<d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>`
          )
      );
    }
    if (path.startsWith(`${booksPrefix}contacts/`)) {
      const name = path.slice(`${booksPrefix}contacts/`.length);
      if (request.method === "REPORT") {
        const body = await request.text();
        const query = /match-type="contains">(?<q>[^<]*)</u.exec(body)?.groups
          ?.q;
        return xml(
          [...user.contacts.entries()]
            .filter(
              ([, vcf]) =>
                query === undefined ||
                vcf.toLowerCase().includes(query.toLowerCase())
            )
            .map(([key, vcf]) =>
              response(
                `${booksPrefix}contacts/${key}`,
                `<d:getetag>"1"</d:getetag><card:address-data>${escapeXml(vcf)}</card:address-data>`
              )
            )
            .join("")
        );
      }
      if (request.method === "PUT") {
        user.contacts.set(name, await request.text());
        return new Response(null, { status: 201 });
      }
    }
    return new Response(null, { status: 404 });
  };

  const userOf = (login: string): FakeUser => {
    const user = accounts.find((account) => account.login === login);
    if (user === undefined) {
      throw new Error(`no fake user ${login}`);
    }
    return user;
  };

  return {
    url: "http://nextcloud.test",
    fetch: handle,
    requests,
    /** Grant the newest pending login flow as `login`, as if they clicked through it in the browser. */
    grant: (login: string) => {
      const pending = [...flows.keys()].at(-1);
      if (pending === undefined) {
        throw new Error("no login flow is pending");
      }
      flows.set(pending, userOf(login));
    },
    /** A fresh app password for `login`, as the person would create one under Settings → Security. */
    appPassword: (login: string) => newAppPassword(userOf(login)),
    user: userOf,
  };
};
