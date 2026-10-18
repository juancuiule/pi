// A sandbox notification reaches the model as `<sandbox-notification at="…" [cut="N"]>\n…\n
// </sandbox-notification>` (src/sandbox/notify.ts formatNotification); the transcript shows it as a
// quiet machine row, not a typed bubble. Lookalikes the person or the payload typed carry a
// zero-width space and never parse. The `cut` flag rides inside the tag — payload text is escaped
// and cannot write attributes, so a payload that merely names the marker still parses faithfully.

export interface SandboxNotification {
  /** The file's writing time, as its mtime rendered to ISO. */
  readonly at: string;
  readonly text: string;
  /** The payload did not fit the byte limit and was cut. */
  readonly truncated: boolean;
}

const MESSAGE =
  // oxlint-disable-next-line prefer-named-capture-group -- the web target predates named groups
  /^<sandbox-notification at="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"(?: cut="(\d+)")?>\n([\s\S]*)\n<\/sandbox-notification>$/u;

export const parseSandboxNotification = (
  text: string
): SandboxNotification | undefined => {
  const match = MESSAGE.exec(text);
  if (match === null) {
    return;
  }
  return {
    at: match[1] ?? "",
    text: match[3] ?? "",
    truncated: match[2] !== undefined,
  };
};
