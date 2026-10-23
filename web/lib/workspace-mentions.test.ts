import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EntryRecord, Message } from "effect-pi/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Transcript } from "../components/console/transcript";
import { complete } from "./autocomplete";
import { initialState } from "./conversation-state";
import { WorkspaceContext } from "./workspace-context";
import { EMPTY_INDEX, workspaceIndexOf } from "./workspace-links";
import type { WorkspaceIndex } from "./workspace-links";
import {
  matchPaths,
  mentionQuery,
  pathSuggestions,
  workspaceMentionParts,
} from "./workspace-mentions";

const TREE = [
  "proposals/",
  "proposals/01-personal-research-insights.md",
  "README.md",
  "src/",
  "src/app.ts",
  "src/lib/",
  "src/lib/util.ts",
  "notes/",
  "notes/team sync.md",
  "my dir/",
  "my dir/a.md",
  ".config/",
  'odd"name.md',
];
const shell = workspaceIndexOf(TREE, { directories: true });
const desktop = workspaceIndexOf(TREE, { directories: false });

describe(mentionQuery, () => {
  it.each([
    ["@pro", undefined, { query: "pro", start: 0, end: 4 }],
    ["see @pro", undefined, { query: "pro", start: 4, end: 8 }],
    ["see\n@", undefined, { query: "", start: 4, end: 5 }],
    ["see @pro then", 7, { query: "pr", start: 4, end: 8 }],
    ['@"notes/te', undefined, { query: "notes/te", start: 0, end: 10 }],
    ['see @"my d" then', 8, { query: "my", start: 4, end: 11 }],
  ] as const)("opens for %j at %s", (prompt, cursor, token) => {
    expect(mentionQuery(prompt, cursor)).toStrictEqual(token);
  });

  it.each(["a@b.com", "(@x", "@pro ", 'see @"a b.md" ', "plain"])(
    "stays closed for %j",
    (prompt) => {
      expect(mentionQuery(prompt)).toBeUndefined();
    }
  );
});

const paths = (index: WorkspaceIndex, query: string) =>
  matchPaths(index, query).map(({ path, kind }) =>
    kind === "directory" ? `${path}/` : path
  );

describe(matchPaths, () => {
  it("lists the root first for an empty query, and dot-folders too", () => {
    const listed = paths(shell, "");
    expect(listed).toHaveLength(8);
    expect(listed.slice(0, 6).toSorted()).toStrictEqual([
      ".config/",
      "README.md",
      "my dir/",
      "notes/",
      "proposals/",
      "src/",
    ]);
  });

  it.each([
    ["app", "src/app.ts"],
    ["APP", "src/app.ts"],
    ["01", "proposals/01-personal-research-insights.md"],
    ["prop", "proposals/"],
    ["insights", "proposals/01-personal-research-insights.md"],
    ["src/l", "src/lib/"],
  ])("ranks %j's best match first", (query, best) => {
    expect(paths(shell, query)[0]).toBe(best);
  });

  it("puts a folder before what is inside it", () => {
    expect(paths(shell, "prop")).toStrictEqual([
      "proposals/",
      "proposals/01-personal-research-insights.md",
    ]);
  });

  it("lists a typed folder's contents, not the folder itself", () => {
    expect(paths(shell, "src/")).toStrictEqual([
      "src/lib/",
      "src/app.ts",
      "src/lib/util.ts",
    ]);
  });

  it("never offers a path no mention can spell", () => {
    expect(paths(shell, "odd")).toStrictEqual([]);
  });

  it("offers at most 8", () => {
    const many = workspaceIndexOf(
      Array.from({ length: 20 }, (_, i) => `file-${i}.md`),
      { directories: true }
    );
    expect(paths(many, "file")).toHaveLength(8);
  });
});

/** The prompt after picking the suggestion labelled `label` with the caret at the end. */
const pick = (prompt: string, label: string, index = shell) => {
  const suggestions = pathSuggestions(prompt, prompt.length, index);
  const option = suggestions?.options.find((o) => o.label === label);
  if (suggestions === undefined || option === undefined) {
    throw new Error(`no ${label} for ${prompt}`);
  }
  return complete(prompt, suggestions, option).prompt;
};

describe(pathSuggestions, () => {
  it("offers nothing without a workspace, or without a match", () => {
    expect(pathSuggestions("@", 1, EMPTY_INDEX)).toBeUndefined();
    expect(pathSuggestions("@zzz", 4, shell)).toBeUndefined();
  });

  it("inserts a file with a trailing space", () => {
    expect(pick("look at @app", "src/app.ts")).toBe("look at @src/app.ts ");
  });

  it("inserts a folder without a space, so the list opens inside it", () => {
    const next = pick("look at @sr", "src/");
    expect(next).toBe("look at @src/");
    expect(pick(next, "src/app.ts")).toBe("look at @src/app.ts ");
  });

  it("quotes a path with spaces, and drills into a folder with spaces", () => {
    expect(pick("@team", "notes/team sync.md")).toBe('@"notes/team sync.md" ');
    const next = pick("@my", "my dir/");
    expect(next).toBe('@"my dir/');
    expect(pick(next, "my dir/a.md")).toBe('@"my dir/a.md" ');
  });

  it("offers no folders at Level desktop", () => {
    expect(
      pathSuggestions("@src", 4, desktop)?.options.map((o) => o.label)
    ).toStrictEqual(["src/app.ts", "src/lib/util.ts"]);
  });
});

const chips = (text: string, index: WorkspaceIndex = shell) =>
  workspaceMentionParts(text, index).map((part) =>
    part.kind === "text"
      ? part.text
      : { chip: part.text, path: part.target.path }
  );

describe(workspaceMentionParts, () => {
  it.each([
    [
      "compare @src/app.ts please",
      ["compare ", { chip: "@src/app.ts", path: "src/app.ts" }, " please"],
    ],
    ["@README.md", [{ chip: "@README.md", path: "README.md" }]],
    [
      'read @"notes/team sync.md" first',
      [
        "read ",
        { chip: '@"notes/team sync.md"', path: "notes/team sync.md" },
        " first",
      ],
    ],
    [
      "see @src/app.ts, then @src/.",
      [
        "see ",
        { chip: "@src/app.ts", path: "src/app.ts" },
        ", then ",
        { chip: "@src/", path: "src" },
        ".",
      ],
    ],
    ["@gone.md and @src/app.ts/", ["@gone.md and @src/app.ts/"]],
    ["mail a@src/app.ts", ["mail a@src/app.ts"]],
  ])("splits %j", (text, parts) => {
    expect(chips(text)).toStrictEqual(parts);
  });

  it("keeps every mention as text without a workspace, and folders at Level desktop", () => {
    expect(chips("@src/app.ts", EMPTY_INDEX)).toStrictEqual(["@src/app.ts"]);
    expect(chips("@src/ and @src/app.ts", desktop)).toStrictEqual([
      "@src/ and ",
      { chip: "@src/app.ts", path: "src/app.ts" },
    ]);
  });

  it.each([
    'compare @src/app.ts, @"my dir/a.md" and @gone.md!',
    "@ @@ @src/ (@README.md)",
  ])("gives back the input when joined: %j", (text) => {
    expect(
      workspaceMentionParts(text, shell)
        .map((part) => part.text)
        .join("")
    ).toBe(text);
  });
});

const message = (content: string, index: WorkspaceIndex) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        WorkspaceContext.Provider,
        { value: { index, open: () => null, refresh: () => null } },
        createElement(Transcript, {
          state: {
            ...initialState,
            entries: [
              {
                id: 1,
                conversationId: 1,
                kind: "message",
                model: [{ role: "user", content } as Message],
              } as unknown as EntryRecord,
            ],
          },
          conversation: 1,
          resuming: false,
          showThinking: true,
          simple: false,
        })
      )
    )
  );

describe("@ mentions in the person's message", () => {
  it("shows a resolved mention as a button that opens the file, and an unresolved one as text", () => {
    const html = message("compare @src/app.ts and @gone.md", shell);
    expect(html.match(/<button[^>]*title="Open file"/gu)).toHaveLength(1);
    expect(html).toContain("src/app.ts</button>");
    expect(html).toContain(" and @gone.md");
  });

  it("shows plain text without a workspace", () => {
    const html = message("compare @src/app.ts", EMPTY_INDEX);
    expect(html).not.toContain('title="Open file"');
    expect(html).toContain("compare @src/app.ts");
  });
});
