// HTML to readable text, without running or fetching anything: a streaming parse (htmlparser2) that keeps the text,
// headings, lists, table rows, image alt text and link targets, and drops scripts, styles, SVG, forms' internals and
// the rest of the markup.
import { Parser } from "htmlparser2";

import { normalizeText } from "./format.ts";

/** Elements whose contents are never text for a reader. */
const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "select",
  "head",
]);

const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hr",
  "html",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "ul",
]);

const HEADING = /^h(?<level>[1-6])$/u;

/** Only links a reader could follow; `javascript:` and the like are left out. */
const FOLLOWABLE = /^(?:https?:|mailto:)/iu;

export const htmlToText = (
  html: string
): { readonly text: string; readonly title?: string } => {
  const out: string[] = [];
  let skipping = 0;
  let inTitle = false;
  let title = "";
  let pre = 0;
  // Each open link's target and where its text starts in `out`.
  const links: { readonly href: string | undefined; readonly at: number }[] =
    [];
  // Whether the current table row has a cell yet.
  let cells = 0;

  const write = (text: string) => {
    out.push(text);
  };
  const breakLine = (blank = false) => write(blank ? "\n\n" : "\n");
  // Paragraph-like blocks are set off by a blank line.
  const breakBlock = (name: string) =>
    breakLine(name === "p" || name === "blockquote" || name === "table");

  // What an element that is read starts with.
  const open = (name: string, attributes: Record<string, string>) => {
    const level = HEADING.exec(name)?.groups?.level;
    if (level !== undefined) {
      breakLine(true);
      write(`${"#".repeat(Number(level))} `);
    } else if (name === "li") {
      breakLine();
      write("- ");
    } else if (name === "tr") {
      breakLine();
      cells = 0;
    } else if (name === "td" || name === "th") {
      write(cells === 0 ? "| " : " | ");
      cells += 1;
    } else if (name === "br") {
      breakLine();
    } else if (name === "pre") {
      pre += 1;
      breakLine(true);
    } else if (BLOCKS.has(name)) {
      breakBlock(name);
    } else if (name === "img") {
      const alt = attributes.alt?.trim() ?? "";
      write(alt === "" ? "" : `[image: ${alt}]`);
    } else if (name === "a") {
      const href = attributes.href?.trim() ?? "";
      links.push({
        href: FOLLOWABLE.test(href) ? href : undefined,
        at: out.length,
      });
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "title") {
          inTitle = true;
          return;
        }
        if (SKIPPED.has(name)) {
          skipping += 1;
          return;
        }
        if (skipping > 0) {
          return;
        }
        open(name, attributes);
      },
      ontext(text) {
        if (inTitle) {
          title += text;
          return;
        }
        if (skipping > 0) {
          return;
        }
        write(pre > 0 ? text : text.replaceAll(/\s+/gu, " "));
      },
      onclosetag(name) {
        if (name === "title") {
          inTitle = false;
          return;
        }
        if (SKIPPED.has(name)) {
          skipping = Math.max(0, skipping - 1);
          return;
        }
        if (skipping > 0) {
          return;
        }
        if (HEADING.test(name)) {
          breakLine(true);
        } else if (name === "pre") {
          pre = Math.max(0, pre - 1);
          breakLine(true);
        } else if (name === "tr" && cells > 0) {
          write(" |");
        } else if (name === "a") {
          const link = links.pop();
          if (link?.href !== undefined) {
            const label = out.slice(link.at).join("").trim();
            if (label !== link.href) {
              write(label === "" ? link.href : ` (${link.href})`);
            }
          }
        } else if (BLOCKS.has(name)) {
          breakBlock(name);
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();

  // Text outside <pre> had its whitespace collapsed already; a line it starts keeps at most a stray space.
  const text = normalizeText(
    out
      .join("")
      .split("\n")
      .map((line) => line.replace(/^ /u, ""))
      .join("\n")
  );
  const trimmedTitle = title.replaceAll(/\s+/gu, " ").trim();
  return trimmedTitle === "" ? { text } : { text, title: trimmedTitle };
};
