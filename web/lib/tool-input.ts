// File-shaped tool arguments: how the console shows write and edit calls instead of raw JSON. Argument shapes come
// from pi's durable tools (repos/pi/packages/durable/src/tools/{write,edit}.ts); a finished edit also carries a
// display-oriented `details.diff` ("+42 line" rows with " ..." elisions) produced by generateDiffString.

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  cxx: "cpp",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mdx: "markdown",
  patch: "diff",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/** A path's extension mapped onto the highlighter's languages; "text" falls back to plain lines. */
export const fileLanguage = (path?: string): string => {
  const base = path?.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const extension = dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "text";
};

export interface EditHunk {
  readonly oldText: string;
  readonly newText: string;
}

const isEditHunk = (value: unknown): value is EditHunk =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).oldText === "string" &&
  typeof (value as Record<string, unknown>).newText === "string";

const hunkOnly = (hunk: EditHunk): EditHunk => ({
  oldText: hunk.oldText,
  newText: hunk.newText,
});

/**
 * The edits a call asked for, normalized the way pi's `prepareEditArguments` accepts them: an `edits` array, that
 * array as a JSON string, a single `{oldText, newText}` object, or a legacy top-level pair. The call's arguments are
 * what the model sent, so the repairs it applies on a copy are repeated here for display.
 */
export const editHunksOf = (
  args?: Record<string, unknown>
): readonly EditHunk[] => {
  if (args === undefined) {
    return [];
  }
  let raw: unknown = args.edits;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  if (Array.isArray(raw)) {
    const hunks = raw.filter(isEditHunk).map(hunkOnly);
    if (hunks.length > 0) {
      return hunks;
    }
  }
  if (isEditHunk(raw)) {
    return [hunkOnly(raw)];
  }
  return isEditHunk(args) ? [hunkOnly(args)] : [];
};

/** The precomputed display diff a finished `edit` call keeps in its result details, when present. */
export const diffOf = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const { diff } = details as Record<string, unknown>;
  return typeof diff === "string" && diff !== "" ? diff : undefined;
};

export interface DiffRow {
  readonly variant: "added" | "removed" | "default";
  readonly text: string;
}

const rowVariant = (line: string): DiffRow["variant"] => {
  if (line.startsWith("+")) {
    return "added";
  }
  if (line.startsWith("-")) {
    return "removed";
  }
  return "default";
};

/**
 * pi's display diff rows: `+NN text`, `-NN text`, ` NN text` and ` ...` elisions. The sigil is dropped because the
 * Code Block's line variants redraw it in the gutter.
 */
export const diffRowsOf = (diff: string): readonly DiffRow[] =>
  diff.split("\n").map((line) => ({
    variant: rowVariant(line),
    text: line.slice(1),
  }));

/** The boilerplate line a successful edit returns as its content; redundant under a rendered diff. */
export const isEditConfirmation = (text: string): boolean =>
  text.startsWith("Successfully replaced ");
