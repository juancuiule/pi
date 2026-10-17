import { describe, expect, it } from "vitest";

import { fileLanguage, filePathOf, isMarkdown } from "./workspace-files";

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
