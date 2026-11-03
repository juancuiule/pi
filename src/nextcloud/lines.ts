// Content lines, the syntax iCalendar (RFC 5545) and vCard (RFC 6350) share: `NAME;PARAM=value:value`, folded at 75
// octets with a leading space on the continuation, and text values escaped with backslashes. Only what the Nextcloud
// tools read and write: components as nested property lists, no recurrence or time zone arithmetic.

export interface Property {
  /** Uppercased, without a group prefix (`item1.EMAIL` is `EMAIL`). */
  readonly name: string;
  /** Uppercased names; values unquoted. */
  readonly params: Readonly<Record<string, string>>;
  /** As written, still escaped; `unescapeText` reads a text value. */
  readonly value: string;
}

export interface Component {
  /** `VCALENDAR`, `VEVENT`, `VCARD`. */
  readonly name: string;
  readonly properties: Property[];
  readonly components: Component[];
}

const unfold = (text: string): string[] =>
  text
    .replaceAll("\r\n", "\n")
    .replaceAll(/\n[ \t]/gu, "")
    .split("\n")
    .filter((line) => line.trim() !== "");

/** One content line, or `undefined` for one without a `:`. */
const parseLine = (line: string): Property | undefined => {
  // The value starts at the first `:` outside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon === -1) {
    return undefined;
  }
  const [head = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const at = raw.indexOf("=");
    if (at !== -1) {
      params[raw.slice(0, at).toUpperCase()] = raw
        .slice(at + 1)
        .replaceAll('"', "");
    }
  }
  const dot = head.lastIndexOf(".");
  return {
    name: (dot === -1 ? head : head.slice(dot + 1)).toUpperCase(),
    params,
    value: line.slice(colon + 1),
  };
};

/** The top-level components of a document; unbalanced BEGIN/END are tolerated. */
export const parseComponents = (text: string): Component[] => {
  const root: Component = { name: "#root", properties: [], components: [] };
  const stack: Component[] = [root];
  for (const line of unfold(text)) {
    const property = parseLine(line);
    if (property === undefined) {
      continue;
    }
    const top = stack.at(-1) ?? root;
    if (property.name === "BEGIN") {
      const component: Component = {
        name: property.value.trim().toUpperCase(),
        properties: [],
        components: [],
      };
      top.components.push(component);
      stack.push(component);
    } else if (property.name === "END") {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      top.properties.push(property);
    }
  }
  return root.components;
};

/** The first property named `name`. */
export const property = (
  component: Component,
  name: string
): Property | undefined => component.properties.find((p) => p.name === name);

export const unescapeText = (value: string): string =>
  value.replaceAll(/\\(?<char>[\\;,nN])/gu, (_match, char: string) =>
    char === "n" || char === "N" ? "\n" : char
  );

export const escapeText = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/gu, "\\n");

/** A text property's value, unescaped; `undefined` when absent or empty. */
export const textValue = (
  component: Component,
  name: string
): string | undefined => {
  const found = property(component, name);
  const value = found === undefined ? "" : unescapeText(found.value).trim();
  return value === "" ? undefined : value;
};

const encoder = new TextEncoder();

/** Fold a line at 75 octets, never inside a UTF-8 sequence. */
const fold = (line: string): string => {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
};

/** Serialize lines (`NAME;PARAM=x:value`, already escaped) with CRLF endings and folding. */
export const serialize = (lines: readonly string[]): string =>
  `${lines.map(fold).join("\r\n")}\r\n`;
