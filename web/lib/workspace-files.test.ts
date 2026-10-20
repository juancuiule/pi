import type { WorkspaceFileEntry } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  entryWirePath,
  fileLanguage,
  filePathOf,
  isMarkdown,
  mergeTreePaths,
  needsChildren,
} from "./workspace-files";

describe(filePathOf, () => {
  it("names the path of a file tool's arguments", () => {
    expect(filePathOf("write", { path: "REPORT.md" })).toBe("REPORT.md");
    expect(filePathOf("read", { path: "/workspace/a.txt" })).toBe(
      "/workspace/a.txt"
    );
    expect(filePathOf("edit", { path: "src/x.ts" })).toBe("src/x.ts");
  });

  it("ignores tools whose path may be a directory, and missing paths", () => {
    for (const tool of ["ls", "find", "grep", "bash"]) {
      expect(filePathOf(tool, { path: "sub" })).toBeUndefined();
    }
    expect(filePathOf("write", {})).toBeUndefined();
  });
});

describe(fileLanguage, () => {
  it("maps known extensions", () => {
    expect(fileLanguage("REPORT.md")).toBe("markdown");
    expect(fileLanguage("src/app.TSX")).toBe("tsx");
    expect(fileLanguage("a/b/c.toml")).toBe("toml");
  });

  it("falls back to text for unknown or extensionless names", () => {
    expect(fileLanguage("README")).toBe("text");
    expect(fileLanguage(".gitignore")).toBe("text");
    expect(fileLanguage("a.xyz")).toBe("text");
  });
});

describe(isMarkdown, () => {
  it("recognizes markdown files", () => {
    expect(isMarkdown("REPORT.md")).toBeTruthy();
    expect(isMarkdown("docs/a.markdown")).toBeTruthy();
    expect(isMarkdown("a.txt")).toBeFalsy();
  });
});

describe(needsChildren, () => {
  it("flags every directory while the listing is truncated", () => {
    expect(needsChildren("src", true)).toBeTruthy();
    expect(needsChildren("a/b/c", true)).toBeTruthy();
  });

  it("flags marker directories and their descendants at any depth", () => {
    expect(needsChildren(".git", false)).toBeTruthy();
    expect(needsChildren("node_modules", false)).toBeTruthy();
    expect(needsChildren(".git/refs", false)).toBeTruthy();
    expect(needsChildren("vendor/node_modules/pkg", false)).toBeTruthy();
  });

  it("leaves listed directories alone when the listing is complete", () => {
    expect(needsChildren("src", false)).toBeFalsy();
    expect(needsChildren("a/b", false)).toBeFalsy();
    // Segment match, not substring: a name that only contains a marker is not one.
    expect(needsChildren("a/b.gitignore", false)).toBeFalsy();
  });
});

const entry = (kind: WorkspaceFileEntry["kind"]): WorkspaceFileEntry => ({
  name: "a",
  path: "src/a",
  kind,
  size: 0,
  mtimeMs: 0,
});

describe(entryWirePath, () => {
  it("gives directories the trailing slash and other kinds none", () => {
    expect(entryWirePath(entry("directory"))).toBe("src/a/");
    expect(entryWirePath(entry("file"))).toBe("src/a");
    expect(entryWirePath(entry("symlink"))).toBe("src/a");
  });
});

describe(mergeTreePaths, () => {
  it("appends a listed directory's fetched children", () => {
    expect(
      mergeTreePaths(["src/", "src/a.ts"], {
        src: ["src/b.ts", "src/lib/"],
      })
    ).toStrictEqual(["src/", "src/a.ts", "src/b.ts", "src/lib/"]);
  });

  it("dedupes children the listing already has", () => {
    expect(
      mergeTreePaths(["src/", "src/a.ts"], { src: ["src/a.ts", "src/"] })
    ).toStrictEqual(["src/", "src/a.ts"]);
  });

  it("drops children whose directory left the listing", () => {
    expect(
      mergeTreePaths(["keep/"], {
        gone: ["gone/a.ts"],
        keep: ["keep/b.ts"],
      })
    ).toStrictEqual(["keep/", "keep/b.ts"]);
  });
});
