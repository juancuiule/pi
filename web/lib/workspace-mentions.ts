// `@` mentions of workspace paths in the person's messages (#103), both directions: the composer's `@` list and
// the transcript's chips. A mention starts with `@` at the start of the text or after whitespace, so emails never
// count. It is `@path` (a folder as `@path/`), or `@"path"` when the path contains whitespace. The text reaches the
// model as typed; src/tools/workspace.ts tells it what the form means.
import type { Suggestion, Suggestions } from "./autocomplete";
import { workspaceTargetOf } from "./workspace-links";
import type { WorkspaceIndex, WorkspaceTarget } from "./workspace-links";

const LIMIT = 8;

/** The `@…` word the cursor is in: what follows the `@` (or `@"`), and where the word starts and ends. */
export interface MentionToken {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/** The `@` word at `cursor` when it should open the list, or `undefined` when the list should be closed. */
export const mentionQuery = (
  prompt: string,
  cursor = prompt.length
): MentionToken | undefined => {
  const before = prompt.slice(0, cursor);
  const after = prompt.slice(cursor);
  const quoted = /(?<=^|\s)@"[^"\n]*$/u.exec(before);
  if (quoted !== null) {
    const close = /^[^"\n]*"/u.exec(after)?.[0] ?? /^\S*/u.exec(after)?.[0];
    return {
      query: quoted[0].slice(2),
      start: quoted.index,
      end: cursor + (close?.length ?? 0),
    };
  }
  const start = before.search(/\S*$/u);
  const token = before.slice(start);
  if (!token.startsWith("@") || token.startsWith('@"')) {
    return;
  }
  return {
    query: token.slice(1),
    start,
    end: cursor + (/^\S*/u.exec(after)?.[0].length ?? 0),
  };
};

const labelOf = (target: WorkspaceTarget): string =>
  target.kind === "directory" ? `${target.path}/` : target.path;

/**
 * Up to LIMIT entries whose path (a folder's with its trailing `/`) contains `query`, case-insensitive. Ranked by
 * where it matches: the file or folder name starts with it, then the path or a later segment does, then anywhere;
 * then fewer segments, then shorter. An empty query lists the root first; `src/` lists what is in src, not src
 * itself. Paths with `"` or a newline are left out, since no mention can spell them.
 */
export const matchPaths = (
  index: WorkspaceIndex,
  query: string
): readonly WorkspaceTarget[] => {
  const wanted = query.toLowerCase();
  const ranked: {
    readonly target: WorkspaceTarget;
    readonly tier: number;
    readonly depth: number;
  }[] = [];
  for (const [path, kind] of index) {
    const target = { path, kind };
    const label = labelOf(target).toLowerCase();
    if (/["\n]/u.test(path) || !label.includes(wanted)) {
      continue;
    }
    if (kind === "directory" && label === wanted) {
      continue;
    }
    const segments = path.toLowerCase().split("/");
    const name = segments.at(-1) ?? "";
    let tier = 2;
    if (name.startsWith(wanted)) {
      tier = 0;
    } else if (label.startsWith(wanted) || label.includes(`/${wanted}`)) {
      tier = 1;
    }
    ranked.push({ target, tier, depth: segments.length });
  }
  return ranked
    .toSorted(
      (a, b) =>
        a.tier - b.tier ||
        a.depth - b.depth ||
        a.target.path.length - b.target.path.length ||
        a.target.path.localeCompare(b.target.path)
    )
    .slice(0, LIMIT)
    .map((entry) => entry.target);
};

const quotes = (label: string) => /\s/u.test(label);

/**
 * The composer's `@` list. A file inserts its mention and a space; a folder inserts `@folder/` with no space (and
 * no closing quote), so the list reopens on what is inside it. Undefined without an `@` word or a match, which
 * covers no Sandbox: its index is empty.
 */
export const pathSuggestions = (
  prompt: string,
  cursor: number,
  index: WorkspaceIndex
): Suggestions | undefined => {
  const token = mentionQuery(prompt, cursor);
  if (token === undefined) {
    return;
  }
  const [first, ...rest] = matchPaths(index, token.query).map(
    (target): Suggestion => {
      const label = labelOf(target);
      const open = quotes(label) ? `@"${label}` : `@${label}`;
      return {
        key: target.path,
        label,
        icon: target.kind,
        insert:
          target.kind === "directory"
            ? open
            : `${open}${quotes(label) ? '"' : ""} `,
      };
    }
  );
  return first === undefined
    ? undefined
    : { start: token.start, end: token.end, options: [first, ...rest] };
};

export type PathMentionPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "path";
      readonly target: WorkspaceTarget;
      readonly text: string;
    };

const MENTION = /(?<=^|\s)@(?:"[^"\n]+"|\S+)/gu;
const TRAILING = /[.,;:!?)\]}'"]+$/u;

// The `@` marks a mention, so a root file needs no "/": "./" lets workspaceTargetOf resolve it.
const resolve = (raw: string, index: WorkspaceIndex) =>
  workspaceTargetOf(raw.includes("/") ? raw : `./${raw}`, index);

/**
 * `text` split around the mentions that resolve against `index`; joining every part's `text` gives back the input.
 * A mention that does not resolve (a deleted file, no Sandbox, a folder at Level desktop) stays text. A bare mention
 * that does not resolve is tried again without its trailing punctuation, which stays text.
 */
export const workspaceMentionParts = (
  text: string,
  index: WorkspaceIndex
): readonly PathMentionPart[] => {
  const parts: PathMentionPart[] = [];
  const plain = (value: string) => {
    const last = parts.at(-1);
    if (value === "") {
      return;
    }
    if (last?.kind === "text") {
      parts[parts.length - 1] = { kind: "text", text: last.text + value };
    } else {
      parts.push({ kind: "text", text: value });
    }
  };
  let at = 0;
  for (const match of index.size === 0 ? [] : text.matchAll(MENTION)) {
    const [written] = match;
    const quoted = /^@"[^"\n]+"$/u.test(written)
      ? written.slice(2, -1)
      : undefined;
    let mention = written;
    let target = resolve(quoted ?? written.slice(1), index);
    const trail =
      quoted === undefined ? TRAILING.exec(written)?.[0] : undefined;
    if (target === undefined && trail !== undefined) {
      mention = written.slice(0, -trail.length);
      target = resolve(mention.slice(1), index);
    }
    if (target !== undefined) {
      plain(text.slice(at, match.index));
      parts.push({ kind: "path", target, text: mention });
      at = match.index + mention.length;
    }
  }
  plain(text.slice(at));
  return parts;
};
