import { readFileSync } from "node:fs";

import type { CallToolResult } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";

import { eglcTransform, htmlToText } from "./eglc.ts";

// A recorded get_wordpress_post result for la-ciencia-del-sueno.
const fixture = JSON.parse(
  readFileSync("src/testing/fixtures/eglc-post.json", "utf-8")
) as CallToolResult;
const textOf = (result: CallToolResult) =>
  result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

describe(htmlToText, () => {
  it("keeps paragraphs, drops tags and decodes entities", () => {
    expect(
      htmlToText(
        "<p><strong>Hola</strong> &amp; chau</p>\n<p>dos&nbsp;<em>líneas</em><br />tres &#8220;x&#8221;</p>"
      )
    ).toBe("Hola & chau\n\ndos líneas\ntres “x”");
  });
});

describe(eglcTransform, () => {
  const shaped = eglcTransform("get_wordpress_post", fixture);
  const post = JSON.parse(textOf(shaped)) as Record<string, unknown>;

  it("keeps the metadata an agent needs from get_wordpress_post", () => {
    expect(Object.keys(post)).toStrictEqual([
      "id_post",
      "title",
      "permalink",
      "date",
      "authors",
      "tags",
      "excerpt",
      "content",
    ]);
    expect(post).toMatchObject({
      id_post: 870,
      title: "La ciencia del sueño",
      date: "2014-05-07",
      authors: ["Facundo Alvarez Heduan"],
    });
    expect(post.tags).toContain("sueño");
  });

  it("keeps the article once, as text, a third of the size or less", () => {
    const content = String(post.content);
    expect(content).toContain("Al principio eran brujas");
    expect(content).not.toContain("<p>");
    // The body appears once.
    expect(content.split("Al principio eran brujas")).toHaveLength(2);
    expect(textOf(shaped).length).toBeLessThan(textOf(fixture).length / 3);
  });

  it("passes other tools and unparseable results through", () => {
    const search: CallToolResult = {
      content: [{ type: "text", text: '{"results":[]}' }],
    };
    expect(eglcTransform("search", search)).toBe(search);
    const broken: CallToolResult = {
      content: [{ type: "text", text: "Post not found" }],
    };
    expect(eglcTransform("get_wordpress_post", broken)).toBe(broken);
  });
});
