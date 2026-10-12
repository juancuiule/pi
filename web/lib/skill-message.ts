// A forced skill reaches the model as `<skill name="…">\n…\n</skill>` then the request (src/skills/format.ts
// formatSkillMessage); the transcript shows it as a chip and the request. A `/skill:<name>` elsewhere in a prompt
// adds a `<skill_hints>` block at the end (formatSkillHints, one `<skill>` with a `<name>` line per hinted skill); the
// transcript drops the block and shows the hinted mentions as chips in the text.

export interface SkillMessage {
  readonly skill: string;
  readonly instructions: string;
  readonly request: string;
}

const OPEN = '<skill name="';
const OPEN_END = '">\n';
const CLOSE = "\n</skill>";
const SKILL_NAME = /^[a-z0-9-]+$/u;

export const parseSkillMessage = (text: string): SkillMessage | undefined => {
  if (!text.startsWith(OPEN)) {
    return;
  }
  const nameEnd = text.indexOf(OPEN_END, OPEN.length);
  const name = text.slice(OPEN.length, nameEnd);
  if (nameEnd === -1 || !SKILL_NAME.test(name)) {
    return;
  }
  const body = text.slice(nameEnd + OPEN_END.length);
  // The last closing tag that ends the text or is followed by a blank line ends the block, so the instructions may
  // themselves contain `</skill>`.
  let at = body.lastIndexOf(CLOSE);
  while (at !== -1) {
    const rest = body.slice(at + CLOSE.length);
    if (rest === "" || rest.startsWith("\n\n")) {
      return {
        skill: name,
        instructions: body.slice(0, at),
        request: rest.slice(2).trim(),
      };
    }
    at = at === 0 ? -1 : body.lastIndexOf(CLOSE, at - 1);
  }
};

const HINTS_OPEN = "\n\n<skill_hints>\n";
const HINTS_CLOSE = "\n</skill_hints>";
const NAME_OPEN = "<name>";
const NAME_CLOSE = "</name>";

/** The text without its trailing `<skill_hints>` block, and the skills the block names. */
export const splitSkillHints = (
  text: string
): { readonly text: string; readonly hinted: readonly string[] } => {
  const at = text.lastIndexOf(HINTS_OPEN);
  if (at === -1 || !text.endsWith(HINTS_CLOSE)) {
    return { text, hinted: [] };
  }
  const lines = text
    .slice(at + HINTS_OPEN.length, -HINTS_CLOSE.length)
    .split("\n");
  const hinted = lines.flatMap((line) => {
    const trimmed = line.trim();
    const name =
      trimmed.startsWith(NAME_OPEN) && trimmed.endsWith(NAME_CLOSE)
        ? trimmed.slice(NAME_OPEN.length, -NAME_CLOSE.length)
        : "";
    return SKILL_NAME.test(name) ? [name] : [];
  });
  return { text: text.slice(0, at), hinted };
};

export type MentionPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "skill"; readonly skill: string };

/** `text` split around the `/skill:<name>` mentions of the `hinted` skills, so they can render as chips. */
export const skillMentionParts = (
  text: string,
  hinted: readonly string[]
): readonly MentionPart[] => {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(
    /(?<=^|\s)\/skill:[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/gu
  )) {
    const name = match[0].slice("/skill:".length);
    if (!hinted.includes(name)) {
      continue;
    }
    if (match.index > last) {
      parts.push({ kind: "text", text: text.slice(last, match.index) });
    }
    parts.push({ kind: "skill", skill: name });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ kind: "text", text: text.slice(last) });
  }
  return parts;
};
