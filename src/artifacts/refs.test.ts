import { describe, expect, it } from "vitest";

import { checkRefs } from "./refs.ts";

const reason = (html: string, trusted: readonly string[] = []) =>
  checkRefs(html, trusted)?.reason ?? "ok";

const img = (src: string) => `<img src="${src}">`;

describe(checkRefs, () => {
  it("allows inline, same-origin, data: and blob: references", () => {
    const html = `
      <script src="/api/artifact-libs/chart.umd.js"></script>
      <script src="chart.umd.js"></script>
      <img src="/api/attachments/att_x/thumbnail?conversation=1">
      <img src="data:image/png;base64,AAA">
      <img src="blob:http://localhost/x">
      <img src="#crop">
      <img src="">
      <a href="https://example.com/post">linked out</a>
      <p style="background: url('/api/x.png')">x</p>
    `;
    expect(reason(html)).toBe("ok");
  });

  it("refuses images on hosts that are not trusted, naming each host", () => {
    const refused = reason(
      `<img src="https://cdn.evil.com/a.png">
       <img src="//cdn.evil.com/b.png">
       <img srcset="https://a.evil.com/1.png 1x, https://b.evil.com/2.png 2x">
       <div style="background: url('https://cdn.evil.com/c.png')">x</div>`,
      ["b.evil.com"]
    );
    expect(refused).toContain("cdn.evil.com");
    expect(refused).toContain("a.evil.com");
    expect(refused).toContain("Trusted domains");
    expect(refused).toContain("trusted domains (b.evil.com)");
    expect(refused).not.toContain("b.evil.com is");
  });

  it("lets images load from exact, wildcard and ported trusted domains", () => {
    const cases: [string, string[]][] = [
      [img("https://cdn.evil.com/a.png"), ["cdn.evil.com"]],
      [img("https://a.b.evil.com/a.png"), ["*.evil.com"]],
      [img("https://evil.com/a.png"), ["*.evil.com"]],
      [img("http://local:8080/a.png"), ["local:8080"]],
      [img("http://local:9090/a.png"), ["local:8080"]],
      [img("https://x.evil.com/a.png"), ["evil.com"]],
    ];
    expect(cases.map(([html, trusted]) => reason(html, trusted))).toStrictEqual(
      [
        "ok",
        "ok",
        expect.stringContaining("not trusted"),
        "ok",
        expect.stringContaining("not trusted"),
        expect.stringContaining("not trusted"),
      ]
    );
  });

  it("refuses what the CSP blocks regardless of the trusted list", () => {
    const cases: [string, string][] = [
      [`<script src="https://cdn.evil.com/x.js"></script>`, "external scripts"],
      [
        `<link rel="stylesheet" href="https://cdn.evil.com/x.css">`,
        "external stylesheets",
      ],
      [`<link rel="stylesheet" href="/x.css">`, "external stylesheets"],
      [`<iframe src="/frame"></iframe>`, "frames"],
      [`<video src="https://cdn.evil.com/v.mp4"></video>`, "audio and video"],
      [
        `<video><source src="https://cdn.evil.com/v.mp4"></video>`,
        "audio and video",
      ],
      [`<form action="/go"></form>`, "form submissions"],
      [`<button formaction="https://x.com">b</button>`, "form submissions"],
      [`<style>@import "/x.css";</style>`, "CSS imports"],
    ];
    const trusted = ["cdn.evil.com"];
    expect(cases.map(([html]) => reason(html, trusted))).toStrictEqual(
      cases.map(([, label]) => expect.stringContaining(label))
    );
  });

  it("refuses remote base and odd image schemes, but same-origin base and posters pass", () => {
    const cases: [string, string[]][] = [
      [`<base href="https://evil.com/">`, []],
      [`<base href="/app/">`, []],
      // oxlint-disable-next-line no-script-url -- a page's src to refuse, not a URL to run
      [img("javascript:alert(1)"), []],
      [img("file:///etc/passwd"), []],
      [`<video poster="https://ok.com/p.png"></video>`, []],
      [`<video poster="https://ok.com/p.png"></video>`, ["ok.com"]],
    ];
    expect(cases.map(([html, trusted]) => reason(html, trusted))).toStrictEqual(
      [
        expect.stringContaining("a base URL"),
        "ok",
        expect.stringContaining("non-web image URLs"),
        expect.stringContaining("non-web image URLs"),
        expect.stringContaining("not trusted"),
        "ok",
      ]
    );
  });

  it("reads a source in a picture as an image and an SVG image/use likewise", () => {
    const cases: [string, string[]][] = [
      [
        `<picture><source srcset="https://cdn.evil.com/a.webp"></picture>`,
        ["cdn.evil.com"],
      ],
      [`<svg><image href="https://cdn.evil.com/a.png"/></svg>`, []],
      [`<svg><script href="https://cdn.evil.com/a.js"/></svg>`, []],
    ];
    expect(cases.map(([html, trusted]) => reason(html, trusted))).toStrictEqual(
      [
        "ok",
        expect.stringContaining("not trusted"),
        expect.stringContaining("external scripts"),
      ]
    );
  });

  it("reports blocked elements and untrusted hosts in one refusal", () => {
    const refused = reason(
      `<script src="https://cdn.evil.com/x.js"></script><img src="https://other.evil.com/i.png">`
    );
    expect(refused).toContain("external scripts");
    expect(refused).toContain("other.evil.com");
  });
});
