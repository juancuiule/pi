// XML-tagged prompt text from plain data, so sections don't hand-write tags. Text is escaped the way pi's coding agent
// escapes its skills list (`escapeXml` in pi-coding-agent's src/core/skills.ts, not exported).

export type XmlValue =
  | string
  | number
  | boolean
  | XmlObject
  | readonly XmlValue[];

export interface XmlObject {
  readonly [tag: string]: XmlValue | undefined;
}

export const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/**
 * `{ tag: value }` as indented XML, two spaces per level: objects nest, arrays repeat their tag, other values become
 * escaped text, and `undefined` is left out.
 */
export const toXml = (value: XmlObject): string => {
  const render = (tag: string, child: XmlValue, depth: number): string[] => {
    if (Array.isArray(child)) {
      return child.flatMap((item: XmlValue) => render(tag, item, depth));
    }
    const pad = "  ".repeat(depth);
    if (typeof child === "object") {
      return [
        `${pad}<${tag}>`,
        ...Object.entries(child as XmlObject).flatMap(([inner, grandchild]) =>
          grandchild === undefined ? [] : render(inner, grandchild, depth + 1)
        ),
        `${pad}</${tag}>`,
      ];
    }
    return [`${pad}<${tag}>${escapeXml(String(child))}</${tag}>`];
  };
  return Object.entries(value)
    .flatMap(([tag, child]) =>
      child === undefined ? [] : render(tag, child, 0)
    )
    .join("\n");
};
