// One-line summaries of tool calls for the transcript headers. Argument shapes come from the tools themselves:
// src/tools/desktop.ts, src/skills/skills.ts (skill) and pi's
// durable/coding-agent tools (bash, read, write, edit, ls, grep, find). Arguments may be missing or partial while a
// call streams, so every read goes through helpers that never throw.

type Args = Record<string, unknown>;

const asArgs = (args: unknown): Args =>
  typeof args === "object" && args !== null ? (args as Args) : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const point = (args: Args, x: string, y: string): string | undefined => {
  const xv = number(args[x]);
  const yv = number(args[y]);
  return xv === undefined || yv === undefined ? undefined : `${xv}, ${yv}`;
};

const grep = (args: Args): string => {
  const pattern = text(args.pattern);
  const path = text(args.path);
  if (pattern !== undefined && path !== undefined) {
    return `${pattern} in ${path}`;
  }
  return pattern ?? path ?? "";
};

const skill = (args: Args): string => {
  const name = text(args.name) ?? "";
  const file = text(args.file);
  return file === undefined ? name : `${name} / ${file}`;
};

const click = (args: Args): string => {
  const at = point(args, "x", "y") ?? "";
  const button = text(args.button);
  return button === undefined ? at : `${at} (${button})`;
};

const scroll = (args: Args): string => {
  const direction = text(args.direction) ?? "";
  const amount = number(args.amount);
  return amount === undefined ? direction : `${direction} ${amount}`;
};

const drag = (args: Args): string => {
  const from = point(args, "fromX", "fromY") ?? "?";
  const to = point(args, "toX", "toY") ?? "?";
  return `${from} → ${to}`;
};

const fallback = (args: Args): string => {
  for (const value of Object.values(args)) {
    const found = text(value);
    if (found !== undefined) {
      return found;
    }
  }
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
};

const askUser = (args: Args): string => {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const first = text(asArgs(questions[0]).question) ?? "";
  return questions.length > 1 ? `${first} (+${questions.length - 1})` : first;
};

const SUMMARIES: Record<string, (args: Args) => string> = {
  bash: (args) => text(args.command) ?? "",
  read: (args) => text(args.path) ?? "",
  write: (args) => text(args.path) ?? "",
  edit: (args) => text(args.path) ?? "",
  ls: (args) => text(args.pattern) ?? text(args.path) ?? "",
  find: (args) => text(args.pattern) ?? text(args.path) ?? "",
  grep,
  skill,
  desktop_click: click,
  desktop_type: (args) => text(args.text) ?? "",
  desktop_key: (args) => text(args.key) ?? text(args.keys) ?? "",
  desktop_scroll: scroll,
  desktop_drag: drag,
  desktop_screenshot: () => "",
  ask_user: askUser,
  web_search: (args) => text(args.query) ?? "",
  artifact_create: (args) => text(args.title) ?? "",
  artifact_update: (args) => text(args.title) ?? "",
};

/** A compact one-line description of a call's arguments; "" when there is nothing meaningful to show. */
export const toolSummary = (name: string, args?: unknown): string => {
  try {
    const summarize = SUMMARIES[name] ?? fallback;
    return summarize(asArgs(args)).replaceAll(/\s+/gu, " ").trim();
  } catch {
    return "";
  }
};
