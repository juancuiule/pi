// The composer's `/` list: while the prompt is a slash command with no whitespace yet, offer the skills.

export interface SkillOption {
  readonly name: string;
  readonly description: string;
}

const COMMAND = "skill:";

/** What follows `/` (without a typed `skill:`), or `undefined` when the list should be closed. */
export const skillQuery = (prompt: string): string | undefined => {
  if (!prompt.startsWith("/") || /\s/u.test(prompt)) {
    return;
  }
  const typed = prompt.slice(1);
  return typed.startsWith(COMMAND) ? typed.slice(COMMAND.length) : typed;
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

export const completeSkill = (name: string): string => `/skill:${name} `;

export const moveSelection = (
  index: number,
  delta: 1 | -1,
  length: number
): number => (length === 0 ? 0 : (index + delta + length) % length);
