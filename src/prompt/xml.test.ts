import { describe, expect, it } from "vitest";

import { escapeXml, toXml } from "./xml.ts";

describe(toXml, () => {
  it("nests objects and repeats a tag for each array item", () => {
    expect(
      toXml({
        list: {
          item: [
            { name: "a", size: 1 },
            { name: "b", hidden: true },
          ],
        },
      })
    ).toBe(
      [
        "<list>",
        "  <item>",
        "    <name>a</name>",
        "    <size>1</size>",
        "  </item>",
        "  <item>",
        "    <name>b</name>",
        "    <hidden>true</hidden>",
        "  </item>",
        "</list>",
      ].join("\n")
    );
  });

  it("escapes text and leaves out undefined values", () => {
    expect(
      toXml({ description: "Converts <unit> & more", missing: undefined })
    ).toBe("<description>Converts &lt;unit&gt; &amp; more</description>");
  });

  it("renders an empty array as nothing", () => {
    expect(toXml({ item: [] })).toBe("");
  });
});

describe(escapeXml, () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;"
    );
  });
});
