// The composer's `/` list. At the start of the prompt a `/` opens it, forcing a skill (`/skill:<name> request`).
// Anywhere else, after whitespace, it opens once `/s` is typed: a mention there hints at the skill to the model
// (src/skills/format.ts formatSkillHints), and a bare `/` mid-text is more often a path than a skill.

export interface SkillOption {
  readonly name: string;
  readonly description: string;
}

/** The `/…` word the cursor is in: what follows `skill:` (or `/`), and where the word starts and ends. */
export interface SkillToken {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

const COMMAND = "skill:";

/** The word at `cursor` when it should open the list, or `undefined` when the list should be closed. */
export const skillQuery = (
  prompt: string,
  cursor = prompt.length
): SkillToken | undefined => {
  const before = prompt.slice(0, cursor);
  const start = before.search(/\S*$/u);
  const token = before.slice(start);
  if (!token.startsWith("/")) {
    return;
  }
  const typed = token.slice(1);
  const command = typed.startsWith(COMMAND);
  if (start > 0 && !command && (typed === "" || !COMMAND.startsWith(typed))) {
    return;
  }
  const end = cursor + (/^\S*/u.exec(prompt.slice(cursor))?.[0].length ?? 0);
  return {
    query: command ? typed.slice(COMMAND.length) : typed,
    start,
    end,
  };
};

/** Skills whose name starts with the query, or all of them while the query is the start of `skill:`. */
export const matchSkills = (
  skills: readonly SkillOption[],
  query: string
): readonly SkillOption[] => {
  const all = skills.toSorted((a, b) => a.name.localeCompare(b.name));
  if (query !== "" && COMMAND.startsWith(query)) {
    return all;
  }
  return all.filter((skill) => skill.name.startsWith(query));
};

/** The prompt with the word replaced by `/skill:<name> `, and where the cursor goes: after the space. */
export const completeSkill = (
  prompt: string,
  token: SkillToken,
  name: string
): { readonly prompt: string; readonly cursor: number } => {
  const inserted = `/skill:${name} `;
  const rest = prompt.slice(token.end).replace(/^ /u, "");
  return {
    prompt: `${prompt.slice(0, token.start)}${inserted}${rest}`,
    cursor: token.start + inserted.length,
  };
};

export const moveSelection = (
  index: number,
  delta: 1 | -1,
  length: number
): number => (length === 0 ? 0 : (index + delta + length) % length);
