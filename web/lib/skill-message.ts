// A forced skill reaches the model as `<skill name="…">\n…\n</skill>` then the request (src/skills.ts
// formatSkillMessage); the transcript shows it as a chip and the request.

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
