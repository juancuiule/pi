// File-shaped tool arguments: how the console shows write and edit calls instead of raw JSON. Argument shapes come
// from pi's durable tools (repos/pi/packages/durable/src/tools/{write,edit}.ts); a finished edit also carries a
// unified `details.patch` produced by generateUnifiedPatch, rendered with @pierre/diffs.

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

/** The unified patch a finished `edit` call keeps in its result details, when present. */
export const patchOf = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const { patch } = details as Record<string, unknown>;
  return typeof patch === "string" && patch !== "" ? patch : undefined;
};

/** The boilerplate line a successful edit returns as its content; redundant under a rendered diff. */
export const isEditConfirmation = (text: string): boolean =>
  text.startsWith("Successfully replaced ");
