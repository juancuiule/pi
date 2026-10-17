// The pure part: `outcomeOf`, `formatSearch` and `detailsOf` over the real SearXNG responses captured in
// src/testing/fixtures/, plus constructed responses for the cases the fixtures do not exercise (HTML in a snippet,
// a duplicated url, a non-http url, a dated page, suggestions on an empty result).
import { readFileSync } from "node:fs";

import { isJsonValue } from "@earendil-works/chord";
import { describe, expect, it } from "vitest";

import {
  detailsOf,
  formatSearch,
  outcomeOf,
  QUERY_MAX_CHARS,
  webSearchSection,
} from "./format.ts";
import type { RawResponse } from "./format.ts";

const fixture = (name: string): RawResponse =>
  JSON.parse(
    readFileSync(
      new URL(`../testing/fixtures/${name}`, import.meta.url),
      "utf-8"
    )
  ) as RawResponse;

describe(outcomeOf, () => {
  it("keeps the first `count` results of a real response, all with http urls", () => {
    const response = fixture("searxng-results.json");
    const outcome = outcomeOf(response, 5);

    expect(response.results?.length).toBeGreaterThan(5);
    expect(outcome.results).toHaveLength(5);
    for (const result of outcome.results) {
      expect(result.url).toMatch(/^https?:\/\//u);
      expect(result.title).not.toBe("");
      expect(result.snippet).not.toContain("<");
    }
    // `publishedDate: null` on every result of this capture is no date at all.
    expect(
      outcome.results.every((result) => result.publishedDate === undefined)
    ).toBeTruthy();
  });

  it("lifts a real SearXNG answer with its source url", () => {
    const outcome = outcomeOf(fixture("searxng-answer.json"), 5);

    expect(outcome.answers).toStrictEqual([
      {
        text: expect.stringContaining("president of Argentina"),
        url: "https://en.wikipedia.org/wiki/President_of_Argentina",
      },
    ]);
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  it("keeps the [engine, reason] pairs of a real empty response", () => {
    const outcome = outcomeOf(fixture("searxng-empty.json"), 5);

    expect(outcome.results).toStrictEqual([]);
    expect(outcome.unresponsive).toStrictEqual([["duckduckgo", "CAPTCHA"]]);
  });

  it("strips tags and decodes entities in titles and snippets", () => {
    const outcome = outcomeOf(
      {
        results: [
          {
            url: "https://example.com/a",
            title: "<b>Tom &amp; Jerry</b>",
            content: "Best <em>cartoon</em> &amp; show&nbsp;ever",
          },
        ],
      },
      5
    );

    expect(outcome.results[0]).toMatchObject({
      title: "Tom & Jerry",
      snippet: "Best cartoon & show ever",
    });
  });

  it("drops non-http urls and duplicates by url without the fragment", () => {
    const outcome = outcomeOf(
      {
        results: [
          { url: "https://example.com/page", title: "one", content: "a" },
          {
            url: "https://example.com/page#section",
            title: "one again",
            content: "b",
          },
          // oxlint-disable-next-line no-script-url -- a scheme to drop, not a URL to run
          { url: "javascript:alert(1)", title: "bad", content: "c" },
          { url: "file:///etc/passwd", title: "bad", content: "d" },
          { url: "not a url", title: "bad", content: "e" },
          { title: "no url", content: "f" },
        ],
      },
      10
    );

    expect(outcome.results.map((result) => result.url)).toStrictEqual([
      "https://example.com/page",
    ]);
  });

  it("falls back to the url when the title is empty, and keeps a real date", () => {
    const outcome = outcomeOf(
      {
        results: [
          { url: "https://example.com/undated", title: "", content: "x" },
          {
            url: "https://example.com/dated",
            title: "Dated",
            content: "y",
            publishedDate: "2026-09-30T00:00:00",
          },
        ],
      },
      5
    );

    expect(outcome.results[0]?.title).toBe("https://example.com/undated");
    expect(outcome.results[1]?.publishedDate).toBe("2026-09-30");
  });

  it("caps titles at 200 and snippets at 300 characters", () => {
    const outcome = outcomeOf(
      {
        results: [
          {
            url: "https://example.com",
            title: "t".repeat(QUERY_MAX_CHARS),
            content: "s".repeat(QUERY_MAX_CHARS),
          },
        ],
      },
      5
    );

    expect(outcome.results[0]?.title).toHaveLength(200);
    expect(outcome.results[0]?.snippet).toHaveLength(300);
  });
});

describe(formatSearch, () => {
  it("numbers results as title, url, snippet; the date follows the snippet", () => {
    const text = formatSearch("effect v4", {
      results: [
        {
          title: "Effect 4.0 is out",
          url: "https://effect.website/blog/effect-4",
          snippet: "Effect 4.0 brings a smaller runtime",
          publishedDate: "2026-09-30",
        },
        {
          title: "Second",
          url: "https://example.com/two",
          snippet: "Another result",
        },
      ],
      answers: [],
      suggestions: [],
      unresponsive: [],
    });

    expect(text).toBe(
      [
        '<search_results query="effect v4">',
        "[1] Effect 4.0 is out",
        "https://effect.website/blog/effect-4",
        "Effect 4.0 brings a smaller runtime (2026-09-30)",
        "",
        "[2] Second",
        "https://example.com/two",
        "Another result",
        "</search_results>",
      ].join("\n")
    );
  });

  it("puts answers first, then the results", () => {
    const text = formatSearch("capital of Argentina", {
      results: [
        {
          title: "T",
          url: "https://example.com",
          snippet: "S",
        },
      ],
      answers: [{ text: "Buenos Aires", url: "https://en.wikipedia.org/x" }],
      suggestions: [],
      unresponsive: [],
    });

    expect(text.indexOf("[answer] Buenos Aires")).toBeLessThan(
      text.indexOf("[1] T")
    );
    expect(text).toContain("https://en.wikipedia.org/x");
  });

  it("says when nothing was found, with suggestions when SearXNG has them", () => {
    const empty = formatSearch("zxqwvortz", {
      results: [],
      answers: [],
      suggestions: [],
      unresponsive: [],
    });
    expect(empty).toContain("No results found.");
    expect(empty).not.toContain("Did you mean");

    const withSuggestions = formatSearch("effect p1", {
      results: [],
      answers: [],
      suggestions: ["effect pi", "effect ps"],
      unresponsive: [],
    });
    expect(withSuggestions).toContain("Did you mean: effect pi, effect ps?");
  });

  it("escapes the query inside the attribute", () => {
    const text = formatSearch('a "quote" <tag>', {
      results: [],
      answers: [],
      suggestions: [],
      unresponsive: [],
    });
    expect(text).toContain('query="a &quot;quote&quot; &lt;tag&gt;"');
  });
});

describe(webSearchSection, () => {
  it("names today, so relative times resolve against it", () => {
    const section = webSearchSection(new Date("2026-10-16T12:00:00"));

    expect(section).toContain("Today is Friday, October 16, 2026");
    expect(section).toContain("Use web_search to look up anything");
  });
});

describe(detailsOf, () => {
  it("lists the shown results as { title, url, publishedDate? } for the console", () => {
    const details = detailsOf(
      "q",
      outcomeOf(
        {
          results: [
            { url: "https://a.example", title: "A", content: "x" },
            {
              url: "https://b.example",
              title: "B",
              content: "y",
              publishedDate: "2026-01-02T10:00:00Z",
            },
          ],
        },
        5
      )
    );

    expect(details).toStrictEqual({
      query: "q",
      sources: [
        { title: "A", url: "https://a.example" },
        { title: "B", url: "https://b.example", publishedDate: "2026-01-02" },
      ],
    });
    // `details` crosses to the console as JSON; it must be a JsonValue.
    expect(isJsonValue(details)).toBeTruthy();
  });
});
