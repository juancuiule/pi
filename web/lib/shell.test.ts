import { describe, expect, it } from "vitest";

import { shellControlOf, shellOpenTargetOf, shellUrl } from "./shell";
import { WORKSPACE_ROOT, workspaceIndexOf } from "./workspace-links";

describe(shellUrl, () => {
  it("points at the server's own URL with the ws scheme and the PTY size", () => {
    const url = new URL(
      shellUrl({
        apiUrl: "http://127.0.0.1:4000",
        conversation: 7,
        columns: 120,
        rows: 40,
      })
    );
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/api/conversations/7/shell");
    expect(url.searchParams.get("cols")).toBe("120");
    expect(url.searchParams.get("rows")).toBe("40");
  });

  it("upgrades https to wss", () => {
    const url = new URL(
      shellUrl({
        apiUrl: "https://pi.example.com",
        conversation: 1,
        columns: 80,
        rows: 24,
      })
    );
    expect(url.protocol).toBe("wss:");
  });
});

describe(shellControlOf, () => {
  it("reads the reason of a closed frame", () => {
    expect(
      shellControlOf('{"type":"closed","reason":"sandbox"}')
    ).toStrictEqual({ type: "closed", reason: "sandbox" });
    expect(shellControlOf('{"type":"closed","reason":"exited"}')).toStrictEqual(
      { type: "closed", reason: "exited" }
    );
  });

  it("maps a reason it does not know to unavailable", () => {
    expect(shellControlOf('{"type":"closed","reason":"bogus"}')).toStrictEqual({
      type: "closed",
      reason: "unavailable",
    });
  });

  it("reads an open frame", () => {
    expect(
      shellControlOf('{"type":"open","path":"/workspace/a.md","kind":"file"}')
    ).toStrictEqual({
      type: "open",
      open: { path: "/workspace/a.md", kind: "file" },
    });
  });

  it("ignores other frames, malformed ones and non-JSON text", () => {
    const texts = [
      '{"type":"resize","columns":10,"rows":5}',
      "not json",
      "null",
      '{"type":"closed"}',
      '{"type":"open","path":"/workspace/a.md","kind":"link"}',
      '{"type":"open","path":7,"kind":"file"}',
      '{"type":"open","kind":"file"}',
    ];
    expect(texts.map((text) => [text, shellControlOf(text)])).toStrictEqual(
      texts.map((text) => [text, undefined])
    );
  });
});

describe(shellOpenTargetOf, () => {
  const index = workspaceIndexOf(
    ["docs/", "docs/readme.md", "node_modules/", "src/", "src/x.ts"],
    { directories: true }
  );
  const target = (path: string, kind: "file" | "directory") =>
    shellOpenTargetOf({ path, kind }, index);

  it("opens the workspace root as the Files tab", () => {
    expect(target("/workspace", "directory")).toStrictEqual(WORKSPACE_ROOT);
  });

  it("opens a file, listed or not", () => {
    expect(target("/workspace/docs/readme.md", "file")).toStrictEqual({
      path: "docs/readme.md",
      kind: "file",
    });
    expect(
      target("/workspace/node_modules/react/index.js", "file")
    ).toStrictEqual({ path: "node_modules/react/index.js", kind: "file" });
  });

  it("reveals a listed folder, else its nearest listed ancestor, else the root", () => {
    expect(target("/workspace/src", "directory")).toStrictEqual({
      path: "src",
      kind: "directory",
    });
    expect(
      target("/workspace/node_modules/react/lib", "directory")
    ).toStrictEqual({ path: "node_modules", kind: "directory" });
    expect(target("/workspace/build/out", "directory")).toStrictEqual(
      WORKSPACE_ROOT
    );
  });

  it("refuses anything outside the workspace or not absolute", () => {
    const paths = [
      "/etc/passwd",
      "docs/readme.md",
      "/workspace/../etc/passwd",
      "/workspacefoo/a.md",
      "/workspace/",
      "",
    ];
    expect(paths.map((path) => [path, target(path, "file")])).toStrictEqual(
      paths.map((path) => [path, undefined])
    );
  });
});
