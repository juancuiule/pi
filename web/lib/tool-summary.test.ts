import { describe, expect, it } from "vitest";

import { toolSummary } from "./tool-summary";

const cases = (inputs: [string, unknown][]): { got: string[] } => ({
  got: inputs.map(([n, a]) => toolSummary(n, a)),
});

describe(toolSummary, () => {
  it("summarizes ask_user by its first question", () => {
    expect(
      cases([
        ["ask_user", { questions: [{ question: "Which database?" }] }],
        [
          "ask_user",
          {
            questions: [{ question: "Which database?" }, { question: "Auth?" }],
          },
        ],
      ]).got
    ).toStrictEqual(["Which database?", "Which database? (+1)"]);
  });

  it("summarizes shell and file tools", () => {
    expect(
      cases([
        ["bash", { command: "ls -la" }],
        ["read", { path: "src/a.ts" }],
        ["write", { path: "b.md", content: "x" }],
        ["edit", { path: "c.ts", edits: [] }],
      ]).got
    ).toStrictEqual(["ls -la", "src/a.ts", "b.md", "c.ts"]);
  });

  it("summarizes search tools", () => {
    expect(
      cases([
        ["ls", { path: "src" }],
        ["find", { pattern: "*.ts", path: "src" }],
        ["find", { path: "src" }],
        ["grep", { pattern: "foo", path: "src" }],
        ["grep", { pattern: "foo" }],
      ]).got
    ).toStrictEqual(["src", "*.ts", "src", "foo in src", "foo"]);
  });

  it("summarizes web_search by its query", () => {
    expect(
      cases([
        ["web_search", { query: "effect v4 release", count: 10 }],
        ["web_search", {}],
      ]).got
    ).toStrictEqual(["effect v4 release", ""]);
  });

  it("summarizes agent tools", () => {
    expect(
      cases([
        ["skill", { name: "research" }],
        ["skill", { name: "research", file: "guide.md" }],
      ]).got
    ).toStrictEqual(["research", "research / guide.md"]);
  });

  it("summarizes desktop tools", () => {
    expect(
      cases([
        ["desktop_click", { x: 10, y: 20 }],
        ["desktop_click", { x: 1, y: 2, button: "right" }],
        ["desktop_type", { text: "hello" }],
        ["desktop_key", { keys: "ctrl+s" }],
        ["desktop_key", { key: "Return" }],
        ["desktop_scroll", { direction: "up", amount: 3 }],
        ["desktop_scroll", { direction: "down" }],
        ["desktop_drag", { fromX: 1, fromY: 2, toX: 3, toY: 4 }],
        ["desktop_screenshot", {}],
      ]).got
    ).toStrictEqual([
      "10, 20",
      "1, 2 (right)",
      "hello",
      "ctrl+s",
      "Return",
      "up 3",
      "down",
      "1, 2 → 3, 4",
      "",
    ]);
  });

  it("summarizes browser tools", () => {
    expect(
      cases([
        ["browser_open", { url: "https://example.com" }],
        ["browser_snapshot", { all: true }],
        ["browser_click", { target: "@e3" }],
        ["browser_fill", { target: "@e5", text: "a@b.c" }],
        ["browser_select", { target: "@e2", values: ["pro", "team"] }],
        ["browser_press", { key: "Enter" }],
        ["browser_scroll", { direction: "down", pixels: 300 }],
        ["browser_wait", { text: "Done" }],
        ["browser_wait", {}],
        ["browser_wait", { ms: 500 }],
        ["browser_text", {}],
        ["browser_navigate", { action: "back" }],
        ["browser_tabs", { switchTo: "t2" }],
      ]).got
    ).toStrictEqual([
      "https://example.com",
      "",
      "@e3",
      "@e5 ← a@b.c",
      "@e2 ← pro, team",
      "Enter",
      "down 300px",
      "Done",
      "page load",
      "500 ms",
      "",
      "back",
      "t2",
    ]);
  });

  it("summarizes the calculator", () => {
    expect(
      cases([
        ["calculate", { expression: "1+2" }],
        ["calculate", { op: "add", a: 1, b: 2 }],
      ]).got
    ).toStrictEqual(["1+2", "1 + 2"]);
  });

  it("falls back for unknown tools", () => {
    expect(
      cases([
        ["weather", { city: "Paris", days: 3 }],
        ["mystery", { n: 1 }],
        ["empty", {}],
      ]).got
    ).toStrictEqual(["Paris", '{"n":1}', "{}"]);
  });

  it("never throws on missing or odd args", () => {
    expect(
      cases([
        ["bash", undefined],
        ["bash", null],
        ["bash", "a string"],
        ["bash", 42],
        ["read", {}],
        ["desktop_click", {}],
        ["desktop_drag", {}],
      ]).got
    ).toStrictEqual(["", "", "", "", "", "", "? → ?"]);
  });

  it("collapses whitespace and newlines", () => {
    expect(toolSummary("bash", { command: "ls \n  -la   foo" })).toBe(
      "ls -la foo"
    );
  });
});
