// The XML Nextcloud's DAV endpoints answer with (a WebDAV multistatus), read into a small tree whose element names
// drop their namespace prefix: servers choose prefixes freely (`d:`, `D:`, none), and the local names DAV,
// CalDAV and CardDAV use do not collide in what is read here. htmlparser2 in xmlMode parses it; nothing is fetched.
import { Parser } from "htmlparser2";

export interface XmlNode {
  /** The local name, lowercased: `response`, `getlastmodified`, `calendar-data`. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

const localName = (name: string): string => {
  const at = name.indexOf(":");
  return (at === -1 ? name : name.slice(at + 1)).toLowerCase();
};

export const parseXml = (xml: string): XmlNode => {
  const root: XmlNode = {
    name: "#root",
    attributes: {},
    children: [],
    text: "",
  };
  const stack: XmlNode[] = [root];
  const parser = new Parser(
    {
      onopentag: (name, attributes) => {
        const node: XmlNode = {
          name: localName(name),
          attributes,
          children: [],
          text: "",
        };
        stack.at(-1)?.children.push(node);
        stack.push(node);
      },
      ontext: (text) => {
        const top = stack.at(-1);
        if (top !== undefined) {
          top.text += text;
        }
      },
      onclosetag: () => {
        stack.pop();
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: true }
  );
  parser.write(xml);
  parser.end();
  return root;
};

/** The first descendant (depth first) named `name`. */
export const find = (node: XmlNode, name: string): XmlNode | undefined => {
  for (const child of node.children) {
    if (child.name === name) {
      return child;
    }
    const found = find(child, name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

/** Every descendant named `name`, not looking inside a match. */
export const findAll = (node: XmlNode, name: string): XmlNode[] =>
  node.children.flatMap((child) =>
    child.name === name ? [child] : findAll(child, name)
  );

/** The trimmed text of the first descendant named `name`, or `undefined`. */
export const textOf = (node: XmlNode, name: string): string | undefined => {
  const found = find(node, name);
  return found === undefined ? undefined : found.text.trim();
};

/** One `<response>` of a multistatus: its href and the props of its 200 propstat. */
export interface DavResponse {
  readonly href: string;
  readonly props: XmlNode;
}

const EMPTY: XmlNode = { name: "prop", attributes: {}, children: [], text: "" };

/** The responses of a multistatus body; props other than 200 (missing ones are 404) are left out. */
export const multistatus = (xml: string): DavResponse[] =>
  findAll(parseXml(xml), "response").map((response) => {
    const ok = findAll(response, "propstat").find((propstat) =>
      (textOf(propstat, "status") ?? "").includes(" 200 ")
    );
    return {
      href: (textOf(response, "href") ?? "").trim(),
      props: (ok === undefined ? undefined : find(ok, "prop")) ?? EMPTY,
    };
  });

/** Escape text for an XML body. */
export const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
