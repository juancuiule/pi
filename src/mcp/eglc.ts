// El Gato y La Caja's search MCP. Its get_wordpress_post returns the post body three times as HTML plus WordPress
// internals (~31k characters for ~7k of text); the transform keeps the article once, as text, with the metadata an
// agent needs, including `id_post`, the id get_recommendations takes.
import type { CallToolResult } from "@earendil-works/pi-mcp";

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decode = (text: string): string =>
  text.replaceAll(
    /&(?<code>#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu,
    (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number(code.slice(1)));
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    }
  );

/** Paragraphs become blank-line separated, `<br>` a newline; every other tag is dropped. */
export const htmlToText = (html: string): string =>
  decode(
    html
      .replaceAll(/<br\s*\/?>/giu, "\n")
      .replaceAll(/<\/(?:p|h[1-6]|li|blockquote|address)>/giu, "\n\n")
      .replaceAll(/<[^>]+>/gu, "")
  )
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

interface WordPressPost {
  readonly id_post: number;
  readonly title: string;
  readonly permalink: string;
  readonly excerpt?: string;
  readonly content: string;
  readonly date_machine?: { readonly date_simple?: string };
  readonly date?: string;
  readonly credits?: {
    readonly autores?: readonly { readonly name: string }[];
  };
  readonly tags?: readonly { readonly name: string }[] | string;
}

const shapePost = (post: WordPressPost) => ({
  id_post: post.id_post,
  title: post.title,
  permalink: post.permalink,
  date: post.date_machine?.date_simple ?? post.date ?? "",
  authors: (post.credits?.autores ?? []).map((author) => author.name),
  tags: Array.isArray(post.tags) ? post.tags.map((tag) => tag.name) : [],
  excerpt: post.excerpt ?? "",
  content: htmlToText(post.content),
});

export const eglcTransform = (
  tool: string,
  result: CallToolResult
): CallToolResult => {
  if (tool !== "get_wordpress_post" || result.isError === true) {
    return result;
  }
  const [block] = result.content;
  if (block?.type !== "text") {
    return result;
  }
  try {
    const post = JSON.parse(block.text) as WordPressPost;
    if (typeof post.content !== "string" || typeof post.id_post !== "number") {
      return result;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(shapePost(post)) }],
    };
  } catch {
    return result;
  }
};
