// What a composer list offers. Each grammar (skill-autocomplete.ts, workspace-mentions.ts) builds it with its own
// spelling in `insert`; the composer only renders it and applies the picked row with `complete`.

export interface Suggestion {
  /** Stable React key: the skill name or the workspace path. */
  readonly key: string;
  /** What the row shows: `/skill:review`, `src/app.ts`, `src/`. */
  readonly label: string;
  /** A second muted line (a skill's description). */
  readonly detail?: string;
  readonly icon: "skill" | "file" | "directory";
  /** The text that replaces the word: `/skill:review `, `@src/app.ts `, or `@src/` to keep the list open inside it. */
  readonly insert: string;
}

/** The word at the cursor that opened the list, and what the list offers. Never built with zero options. */
export interface Suggestions {
  readonly start: number;
  readonly end: number;
  readonly options: readonly [Suggestion, ...Suggestion[]];
}

/** The prompt with [start, end) replaced by `insert`, and the caret after it. An insert ending in a space drops one following space. */
export const complete = (
  prompt: string,
  suggestions: Pick<Suggestions, "start" | "end">,
  option: Pick<Suggestion, "insert">
): { readonly prompt: string; readonly cursor: number } => {
  const rest = prompt.slice(suggestions.end);
  return {
    prompt: `${prompt.slice(0, suggestions.start)}${option.insert}${option.insert.endsWith(" ") ? rest.replace(/^ /u, "") : rest}`,
    cursor: suggestions.start + option.insert.length,
  };
};

export const moveSelection = (
  index: number,
  delta: 1 | -1,
  length: number
): number => (length === 0 ? 0 : (index + delta + length) % length);
