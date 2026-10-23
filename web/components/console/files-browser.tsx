"use client";

import { prepareFileTreeInput } from "@pierre/trees";
import type { FileTreeBatchOperation } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { runApi } from "@/lib/api";
import { useWorkspaceTree } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace-context";
import type { TreeChildren } from "@/lib/workspace-files";
import {
  cappedDirs,
  entryWirePath,
  mergeTreePaths,
  needsChildren as listingNeedsChildren,
} from "@/lib/workspace-files";
import { normalizeWorkspacePath } from "@/lib/workspace-links";
import type { WorkspacePath } from "@/lib/workspace-links";

/**
 * The tree reads the console's palette through its --trees-theme-* layer. The built-in values that stay
 * (file icons, scrollbar) resolve with light-dark(), so the host's `color-scheme` follows the console's
 * `.dark` class, not the OS.
 */
const TREE_STYLE = {
  "--trees-font-family": "var(--font-sans)",
  "--trees-theme-sidebar-bg": "var(--background)",
  "--trees-theme-sidebar-fg": "var(--foreground)",
  "--trees-theme-sidebar-header-fg": "var(--muted-foreground)",
  "--trees-theme-sidebar-border": "var(--border)",
  "--trees-theme-input-bg": "var(--muted)",
  "--trees-theme-input-fg": "var(--foreground)",
  "--trees-theme-input-border": "var(--border)",
  "--trees-theme-list-hover-bg": "var(--accent)",
  "--trees-theme-list-active-selection-bg": "var(--secondary)",
  "--trees-theme-list-active-selection-fg": "var(--secondary-foreground)",
  "--trees-theme-focus-ring": "var(--ring)",
} as CSSProperties;

/**
 * The workspace tree (@pierre/trees, the diffs sibling already used for edits): the whole workspace at once,
 * directories expandable in place, built-in search. Selecting a file opens it in the file pane beside the chat.
 */
const Tree = ({
  paths,
  capped,
  onLoadDirectory,
  needsChildren,
  reveal,
  revealSeq,
  onRevealed,
}: {
  paths: readonly string[];
  capped: ReadonlySet<string>;
  onLoadDirectory: (dir: string) => void;
  needsChildren: (dir: string) => boolean;
  reveal: WorkspacePath | undefined;
  revealSeq: number;
  onRevealed: (seq: number) => void;
}) => {
  const { open } = useWorkspace();
  // Options apply once, when the model is created; the callbacks read the newest data through refs.
  const live = useRef({
    dirs: new Set<string>(),
    capped,
    open,
    onLoadDirectory,
    needsChildren,
  });
  const seen = useRef(new Set<string>());
  useEffect(() => {
    live.current = {
      dirs: new Set(
        paths
          .filter((path) => path.endsWith("/"))
          .map((path) => path.slice(0, -1))
      ),
      capped,
      open,
      onLoadDirectory,
      needsChildren,
    };
  });
  const prepared = useMemo(
    () => prepareFileTreeInput(paths, { flattenEmptyDirectories: true }),
    [paths]
  );
  const { model } = useFileTree({
    preparedInput: prepared,
    search: true,
    icons: "standard",
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    onSelectionChange: (selected) => {
      const added = selected.find((path) => !seen.current.has(path));
      seen.current = new Set(selected);
      if (added === undefined) {
        return;
      }
      const dir = added.replace(/\/+$/u, "");
      if (!live.current.dirs.has(dir)) {
        const path = normalizeWorkspacePath(added);
        if (path !== undefined) {
          live.current.open({ path, kind: "file" });
        }
        return;
      }
      // A directory whose children the listing withheld has nothing to expand; selecting it fetches them.
      if (live.current.needsChildren(dir)) {
        live.current.onLoadDirectory(dir);
      }
    },
    // A badge on a directory the endpoint cut short: it holds more entries than the row list shows.
    renderRowDecoration: ({ row }) =>
      live.current.capped.has(row.path.replace(/\/+$/u, ""))
        ? { text: "500+", title: "Only the first 500 entries are listed" }
        : null,
  });
  // Refreshed listings flow in as add/remove diffs: resetPaths would rebuild the store and collapse expansion.
  const previous = useRef(paths);
  useEffect(() => {
    if (previous.current === paths) {
      return;
    }
    const before = new Set(previous.current);
    const after = new Set(paths);
    const operations: FileTreeBatchOperation[] = [
      ...paths
        .filter((path) => !before.has(path))
        .map((path) => ({ type: "add" as const, path })),
      ...previous.current
        .filter((path) => !after.has(path))
        .map((path) => ({ type: "remove" as const, path, recursive: true })),
    ];
    previous.current = paths;
    if (operations.length > 0) {
      model.batch(operations);
    }
  }, [model, paths]);
  // Expansion has no callback: rescan the visible rows on every model change and fetch the children
  // of each expanded directory the listing withheld. Fetches dedupe in FilesBrowser, so the
  // fetch → merge → batch → notify pass settles.
  useEffect(
    () =>
      model.subscribe(() => {
        for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
          if (row.kind !== "directory" || !row.isExpanded) {
            continue;
          }
          const dir = row.path.replace(/\/+$/u, "");
          if (live.current.needsChildren(dir)) {
            live.current.onLoadDirectory(dir);
          }
        }
      }),
    [model]
  );
  // A folder link: expand it (expanding a directory expands its ancestors too), select its row and
  // scroll to it. scrollToPath only finds a visible row, so it runs after the expansion; a filter
  // could hide it. A folder inside a flattened chain ("deep / nest / inner") has no row of its own,
  // and scrollToPath and focusNearestPath both miss it, so the reveal lands on the first visible row
  // under the folder: its own row, or the chain's.
  useEffect(() => {
    if (reveal === undefined) {
      return;
    }
    const item = model.getItem(`${reveal}/`);
    if (item !== null && "expand" in item) {
      if (model.isSearchOpen()) {
        model.closeSearch();
      }
      item.expand();
      if (live.current.needsChildren(reveal)) {
        live.current.onLoadDirectory(reveal);
      }
      const row =
        model
          .getVisibleRows(0, model.getVisibleCount())
          .find((visible) => visible.path.startsWith(`${reveal}/`))?.path ??
        `${reveal}/`;
      const shown = model.getItem(row);
      if (shown !== null && "expand" in shown) {
        shown.expand();
      }
      for (const selected of model.getSelectedPaths()) {
        model.getItem(selected)?.deselect();
      }
      shown?.select();
      model.scrollToPath(row, { offset: "center", focus: true });
    }
    onRevealed(revealSeq);
  }, [model, reveal, revealSeq, onRevealed]);
  return (
    <FileTree
      model={model}
      className="h-full min-h-0 [color-scheme:light] dark:[color-scheme:dark]"
      style={TREE_STYLE}
    />
  );
};

/**
 * The Files tab: the workspace's files as a tree, listed live through the conversation's Sandbox. A file opens
 * in the file pane beside the chat. Without a Seat (paused, archived) there is no Sandbox to list through; the
 * workspace keeps its files for the next one.
 */
export const FilesBrowser = ({
  id,
  live,
  reveal,
  revealSeq,
  onRevealed,
}: {
  id: number;
  live: boolean;
  /** A folder to expand and scroll to (a folder link), acknowledged through onRevealed. */
  reveal: WorkspacePath | undefined;
  revealSeq: number;
  onRevealed: (seq: number) => void;
}) => {
  // The listing follows the agent's writes, like the file pane follows one file.
  const { data, error } = useWorkspaceTree(id, { live, poll: true });
  // Children the tree listing withheld (truncated or skipped dirs), fetched per directory on expand.
  const [extra, setExtra] = useState<Readonly<Record<string, TreeChildren>>>(
    {}
  );
  // Directories already asked for, in flight or listed; a failure drops the dir so a later
  // trigger retries it.
  const requested = useRef(new Set<string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const loadDirectory = useCallback(
    (dir: string) => {
      if (requested.current.has(dir)) {
        return;
      }
      requested.current.add(dir);
      void (async () => {
        try {
          const { entries, truncated } = await runApi((c) =>
            c.files.list({ params: { id }, query: { path: dir } })
          );
          if (mounted.current) {
            setExtra((prev) => ({
              ...prev,
              [dir]: { paths: entries.map(entryWirePath), truncated },
            }));
          }
        } catch {
          requested.current.delete(dir);
        }
      })();
    },
    [id]
  );
  const truncated = data?.truncated ?? false;
  const dirNeedsChildren = useCallback(
    (dir: string) => listingNeedsChildren(dir, truncated),
    [truncated]
  );
  const paths = useMemo(
    () => mergeTreePaths(data?.paths ?? [], extra),
    [data, extra]
  );
  const capped = useMemo(() => cappedDirs(extra), [extra]);

  if (!live) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Paused — resume the conversation to browse its files.
      </p>
    );
  }
  if (error !== null) {
    return (
      <p role="alert" className="text-destructive p-4 text-sm">
        {error.message}
      </p>
    );
  }
  if (data === undefined) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
        <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
        Loading…
      </p>
    );
  }
  if (data.paths.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        The workspace is empty.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col pt-4">
      <div className="min-h-0 flex-1">
        <Tree
          paths={paths}
          capped={capped}
          onLoadDirectory={loadDirectory}
          needsChildren={dirNeedsChildren}
          reveal={reveal}
          revealSeq={revealSeq}
          onRevealed={onRevealed}
        />
      </div>
      {data.truncated ? (
        <p className="text-muted-foreground shrink-0 border-t px-3 py-1.5 text-xs">
          Only the first 4000 paths are listed. Expanding a folder loads its
          contents.
        </p>
      ) : null}
    </div>
  );
};
