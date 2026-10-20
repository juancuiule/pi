// One-line summaries of tool calls for the transcript headers. Argument shapes come from the tools themselves:
// src/tools/desktop.ts, src/tools/browser.ts, src/tools/calculator.ts, src/skills/skills.ts (skill) and pi's
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

const OPS: Record<string, string> = {
  add: "+",
  subtract: "−",
  multiply: "×",
  divide: "÷",
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

const calculate = (args: Args): string => {
  const expression = text(args.expression);
  if (expression !== undefined) {
    return expression;
  }
  const a = number(args.a);
  const b = number(args.b);
  const op = text(args.op);
  return a === undefined || b === undefined || op === undefined
    ? ""
    : `${a} ${OPS[op] ?? op} ${b}`;
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

const browserFill = (args: Args): string => {
  const target = text(args.target) ?? "";
  const value = text(args.text);
  return value === undefined ? target : `${target} ← ${value}`;
};

const browserSelect = (args: Args): string => {
  const target = text(args.target) ?? "";
  const values = Array.isArray(args.values)
    ? args.values.flatMap((value) => text(value) ?? [])
    : [];
  return values.length === 0 ? target : `${target} ← ${values.join(", ")}`;
};

const browserScroll = (args: Args): string => {
  const direction = text(args.direction) ?? "";
  const pixels = number(args.pixels);
  return pixels === undefined ? direction : `${direction} ${pixels}px`;
};

const browserWait = (args: Args): string => {
  const ms = number(args.ms);
  return (
    text(args.target) ??
    text(args.text) ??
    text(args.url) ??
    (ms === undefined ? "page load" : `${ms} ms`)
  );
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
  browser_open: (args) => text(args.url) ?? "",
  browser_snapshot: () => "",
  browser_click: (args) => text(args.target) ?? "",
  browser_fill: browserFill,
  browser_select: browserSelect,
  browser_press: (args) => text(args.key) ?? "",
  browser_scroll: browserScroll,
  browser_wait: browserWait,
  browser_text: (args) => text(args.target) ?? "",
  browser_screenshot: () => "",
  browser_navigate: (args) => text(args.action) ?? "",
  browser_tabs: (args) => text(args.switchTo) ?? "",
  calculate,
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
