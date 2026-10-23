// Workspace links: path mentions in the agent's answers that point at a file or folder of the
// conversation's workspace. Recognition is pure and resolves only against the tree listing
// (GET /api/conversations/:id/files/tree), so a mention of anything else stays plain text.
import type { ConversationSummary } from "effect-pi/api";
import type { Link, Nodes, Parent, PhrasingContent, Root } from "mdast";

import { seatlessOf } from "./conversation-status";

export type WorkspaceKind = "file" | "directory";

/**
 * A path under the workspace root as the tree endpoint writes it, minus a directory's trailing "/".
 * Never "", never absolute, no "." or ".." segments. Only normalizeWorkspacePath mints it, so an
 * unnormalized string cannot reach the open action.
 */
export type WorkspacePath = string & { readonly __brand: "WorkspacePath" };

/** What the open action receives: a file opens the file pane, a directory the Files tab at it. */
export interface WorkspaceTarget {
  readonly path: WorkspacePath;
  readonly kind: WorkspaceKind;
}

/** The workspace root, which no WorkspacePath names: the Files tab with nothing revealed. */
export interface WorkspaceRoot {
  readonly kind: "root";
}

export const WORKSPACE_ROOT: WorkspaceRoot = { kind: "root" };

/** What the open action takes: a file, a folder, or the root (the shell's `open .` at /workspace). */
export type OpenTarget = WorkspaceTarget | WorkspaceRoot;

/**
 * The paths a link may point at, each with its kind. Built from the tree listing only, so skipped
 * subtrees and entries past its 4000 cap are absent and never link.
 */
export type WorkspaceIndex = ReadonlyMap<WorkspacePath, WorkspaceKind>;

export const EMPTY_INDEX: WorkspaceIndex = new Map();

const ROOT = "/workspace";

/**
 * "/workspace/a/b", "./a/b", "a/b" and "a/b/" all name "a/b". Undefined for the root itself, any
 * other absolute path, "~", URLs, and empty, "." or ".." segments.
 */
export const normalizeWorkspacePath = (
  raw: string
): WorkspacePath | undefined => {
  let path = raw;
  if (path === ROOT || path === `${ROOT}/`) {
    return undefined;
  }
  if (path.startsWith(`${ROOT}/`)) {
    path = path.slice(ROOT.length + 1);
  } else if (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  if (path.startsWith("/") || path.startsWith("~") || path.includes("://")) {
    return undefined;
  }
  const valid = path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return valid ? (path as WorkspacePath) : undefined;
};

/** The tree listing as an index. `directories: false` leaves folders out. */
export const workspaceIndexOf = (
  treePaths: readonly string[],
  options: { readonly directories: boolean }
): WorkspaceIndex => {
  const index = new Map<WorkspacePath, WorkspaceKind>();
  for (const listed of treePaths) {
    const kind: WorkspaceKind = listed.endsWith("/") ? "directory" : "file";
    if (kind === "directory" && !options.directories) {
      continue;
    }
    const path = normalizeWorkspacePath(listed);
    if (path !== undefined) {
      index.set(path, kind);
    }
  }
  return index;
};

/**
 * The links a conversation's answers may carry. No Sandbox (Level none, paused, archived) means no
 * links; at Level desktop folders do not link, since there is no Files tab to show them in.
 */
export const linkIndexOf = (
  conversation: Pick<ConversationSummary, "sandbox" | "status"> | undefined,
  treePaths?: readonly string[]
): WorkspaceIndex => {
  if (
    conversation === undefined ||
    treePaths === undefined ||
    conversation.sandbox === "none" ||
    seatlessOf(conversation)
  ) {
    return EMPTY_INDEX;
  }
  return workspaceIndexOf(treePaths, {
    directories: conversation.sandbox === "shell",
  });
};

/**
 * One mention as written, resolved against the index. It must contain a "/" (a bare "README.md"
 * never links; "./README.md" does), and a trailing "/" only resolves a folder. The single statement
 * of the rule for answers, the shell's `open` and `@` mentions alike.
 */
export const workspaceTargetOf = (
  raw: string,
  index: WorkspaceIndex
): WorkspaceTarget | undefined => {
  if (!raw.includes("/")) {
    return undefined;
  }
  const path = normalizeWorkspacePath(raw);
  const kind = path === undefined ? undefined : index.get(path);
  if (path === undefined || kind === undefined) {
    return undefined;
  }
  if (kind === "file" && raw.endsWith("/")) {
    return undefined;
  }
  return { path, kind };
};

const LINE_SUFFIX = /.:\d+(?::\d+)?$/u;

/** Like workspaceTargetOf, but `a.ts:42` (or `a.ts:42:7`) resolves `a.ts` and returns `:42` as the rest. */
const mentionOf = (
  raw: string,
  index: WorkspaceIndex
): { readonly target: WorkspaceTarget; readonly rest: string } | undefined => {
  const target = workspaceTargetOf(raw, index);
  if (target !== undefined) {
    return { target, rest: "" };
  }
  const suffix = LINE_SUFFIX.exec(raw);
  if (suffix === null) {
    return undefined;
  }
  // The match includes the path's last character, so the path is never empty.
  const rest = suffix[0].slice(1);
  const found = workspaceTargetOf(raw.slice(0, -rest.length), index);
  return found === undefined ? undefined : { target: found, rest };
};

/** A run of prose; joining every `text` gives back the input exactly. */
export type ProseSegment =
  | { readonly text: string; readonly target?: undefined }
  | { readonly text: string; readonly target: WorkspaceTarget };

const LEADING = /^[([{"'<“‘]+/u;
const TRAILING = /[)\]}"'>.,;:!?”’]+$/u;

/** Splits prose around the bare path tokens that resolve; punctuation around a token stays plain. */
export const splitProse = (
  text: string,
  index: WorkspaceIndex
): readonly ProseSegment[] => {
  const segments: ProseSegment[] = [];
  const plain = (value: string) => {
    if (value === "") {
      return;
    }
    const last = segments.at(-1);
    if (last !== undefined && last.target === undefined) {
      segments[segments.length - 1] = { text: last.text + value };
    } else {
      segments.push({ text: value });
    }
  };
  for (const token of text.match(/\s+|\S+/gu) ?? []) {
    if (!token.includes("/")) {
      plain(token);
      continue;
    }
    const lead = LEADING.exec(token)?.[0] ?? "";
    const trail = TRAILING.exec(token.slice(lead.length))?.[0] ?? "";
    const core = token.slice(lead.length, token.length - trail.length);
    const mention = mentionOf(core, index);
    if (mention === undefined) {
      plain(token);
      continue;
    }
    plain(lead);
    segments.push({
      text: core.slice(0, core.length - mention.rest.length),
      target: mention.target,
    });
    plain(mention.rest + trail);
  }
  return segments;
};

const mark = <T extends Nodes>(node: T, target: WorkspaceTarget): T => {
  node.data = {
    ...node.data,
    hProperties: {
      dataWorkspacePath: target.path,
      dataWorkspaceKind: target.kind,
    },
  };
  return node;
};

const decoded = (url: string): string => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

/** Node types whose text is never a mention: code, raw HTML, references, and existing links' labels. */
const SKIPPED = new Set([
  "code",
  "html",
  "definition",
  "image",
  "imageReference",
  "linkReference",
]);

const linkTo = (target: WorkspaceTarget, child: PhrasingContent): Link =>
  mark({ type: "link", url: "", children: [child] }, target);

const walk = (parent: Parent, index: WorkspaceIndex): void => {
  const children: Nodes[] = [];
  for (const node of parent.children) {
    if (node.type === "text") {
      for (const segment of splitProse(node.value, index)) {
        const text = { type: "text" as const, value: segment.text };
        children.push(
          segment.target === undefined ? text : linkTo(segment.target, text)
        );
      }
    } else if (node.type === "inlineCode") {
      const mention = mentionOf(node.value.trim(), index);
      children.push(
        mention === undefined ? node : linkTo(mention.target, node)
      );
    } else if (node.type === "link") {
      const target = workspaceTargetOf(decoded(node.url), index);
      children.push(target === undefined ? node : mark(node, target));
    } else {
      if (!SKIPPED.has(node.type) && "children" in node) {
        walk(node, index);
      }
      children.push(node);
    }
  }
  // The rebuilt list holds the same kinds of nodes the parent held, plus links in phrasing positions.
  parent.children = children as Parent["children"];
};

/**
 * The remark plugin. It runs after remark-gfm, so autolinks are already `link` nodes; a link is
 * marked when its target resolves and is never descended, so no link lands inside another. A new
 * link gets url "", so the rendered element carries no navigable href.
 */
export const remarkWorkspaceLinks =
  (options: { readonly index: WorkspaceIndex }) =>
  (tree: Root): void => {
    walk(tree, options.index);
  };

/** The target a rendered element carries, read back from the properties the plugin set. */
export const markedTargetOf = (
  properties: Readonly<Record<string, unknown>> | undefined
): WorkspaceTarget | undefined => {
  const raw = properties?.dataWorkspacePath;
  const kind = properties?.dataWorkspaceKind;
  if (typeof raw !== "string" || (kind !== "file" && kind !== "directory")) {
    return undefined;
  }
  const path = normalizeWorkspacePath(raw);
  return path === undefined ? undefined : { path, kind };
};
