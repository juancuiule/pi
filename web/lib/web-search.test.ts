import { describe, expect, it } from "vitest";

import { sourcesOf } from "./web-search";

describe(sourcesOf, () => {
  it("reads the sources of a real details payload", () => {
    const sources = sourcesOf({
      query: "effect v4",
      sources: [
        {
          title: "Effect 4.0 is out",
          url: "https://effect.website/blog/effect-4",
          publishedDate: "2026-09-30",
        },
        { title: "Repo", url: "https://github.com/Effect-TS/effect" },
      ],
    });

    expect(sources).toStrictEqual([
      {
        title: "Effect 4.0 is out",
        url: "https://effect.website/blog/effect-4",
        publishedDate: "2026-09-30",
      },
      { title: "Repo", url: "https://github.com/Effect-TS/effect" },
    ]);
  });

  it("is empty when there is no details or no sources", () => {
    expect(sourcesOf(null)).toStrictEqual([]);
    expect(sourcesOf("details")).toStrictEqual([]);
    expect(sourcesOf({ query: "q" })).toStrictEqual([]);
    expect(sourcesOf({ sources: "none" })).toStrictEqual([]);
  });

  it("drops entries that are not http links to a titled page", () => {
    const sources = sourcesOf({
      sources: [
        { title: "Good", url: "https://a.example" },
        { title: "No url" },
        { url: "https://b.example" },
        // oxlint-disable-next-line no-script-url -- a scheme to drop, not a URL to run
        { title: "Odd scheme", url: "javascript:alert(1)" },
        "https://c.example",
      ],
    });

    expect(sources).toStrictEqual([
      { title: "Good", url: "https://a.example" },
    ]);
  });
});
