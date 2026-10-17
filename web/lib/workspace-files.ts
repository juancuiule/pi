// Workspace files in the console: the files inside a conversation's Sandbox, listed and read through
// GET /api/conversations/:id/files* (src/server/handlers.ts). Text is shown highlighted, Markdown also
// rendered, and binaries are only described — the file pane never executes a workspace file.

/** A workspace file opened in the file pane, by the path the agent used. */
export interface OpenFile {
  readonly path: string;
}

/**
 * The file tools whose `path` argument names a file the pane can open. `ls`, `find` and `grep` paths may be
 * directories, so their calls do not get the open action.
 */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

/** The workspace path a call's arguments name, when they name a file. */
export const filePathOf = (name: string, args: unknown): string | undefined => {
  if (!FILE_TOOLS.has(name)) {
    return undefined;
  }
  const { path } = (args ?? {}) as Record<string, unknown>;
  return typeof path === "string" && path !== "" ? path : undefined;
};

const LANGUAGES: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

/** The extension part of a path, lowercase; "" for dotfiles and extensionless names. */
const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** The Shiki language for a path, "text" (plain) for one the highlighter does not know. */
export const fileLanguage = (path: string): string =>
  LANGUAGES[extensionOf(path)] ?? "text";

/** Markdown renders as a document; everything else shows as source only. */
export const isMarkdown = (path: string): boolean => {
  const ext = extensionOf(path);
  return ext === "md" || ext === "markdown";
};
