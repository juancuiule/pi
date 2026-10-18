// A sandbox notification reaches the model as `<sandbox-notification at="…">\n…\n</sandbox-notification>`
// (src/sandbox/notify.ts formatNotification); the transcript shows it as a quiet machine row, not a typed
// bubble. Lookalikes the person or the payload typed carry a zero-width space and never parse.

export interface SandboxNotification {
  /** The file's writing time, as its mtime rendered to ISO. */
  readonly at: string;
  readonly text: string;
  /** The payload did not fit the byte limit and was cut. */
  readonly truncated: boolean;
}

const OPEN = '<sandbox-notification at="';
const OPEN_END = '">\n';
const CLOSE = "\n</sandbox-notification>";
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CUT = /\n\[notification cut at \d+ bytes\]$/u;

export const parseSandboxNotification = (
  text: string
): SandboxNotification | undefined => {
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) {
    return;
  }
  const openEnd = text.indexOf(OPEN_END, OPEN.length);
  const at = text.slice(OPEN.length, openEnd);
  if (openEnd === -1 || !AT.test(at)) {
    return;
  }
  const body = text.slice(openEnd + OPEN_END.length, -CLOSE.length);
  const cut = CUT.exec(body);
  return {
    at,
    text: cut === null ? body : body.slice(0, -cut[0].length),
    truncated: cut !== null,
  };
};
