"use client";

import { prepareFileTreeInput } from "@pierre/trees";
import type { FileTreeBatchOperation } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import { runApi } from "@/lib/api";
import { useOpenFile } from "@/lib/file-context";

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
const Tree = ({ paths }: { paths: readonly string[] }) => {
  const openFile = useOpenFile();
  // Options apply once, when the model is created; the callbacks read the newest data through refs.
  const live = useRef({ dirs: new Set<string>(), openFile });
  const seen = useRef(new Set<string>());
  useEffect(() => {
    live.current = {
      dirs: new Set(
        paths
          .filter((path) => path.endsWith("/"))
          .map((path) => path.slice(0, -1))
      ),
      openFile,
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
      if (
        added !== undefined &&
        !live.current.dirs.has(added.replace(/\/+$/u, ""))
      ) {
        live.current.openFile?.({ path: added });
      }
    },
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
export const FilesBrowser = ({ id, live }: { id: number; live: boolean }) => {
  const { data, error } = useQuery({
    queryKey: ["workspace-tree", id],
    queryFn: () => runApi((c) => c.files.tree({ params: { id } })),
    // The listing follows the agent's writes, like the file pane follows one file.
    enabled: live,
    refetchInterval: 2000,
  });

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Tree paths={data.paths} />
      </div>
      {data.truncated ? (
        <p className="text-muted-foreground shrink-0 border-t px-3 py-1.5 text-xs">
          Only the first 4000 paths are shown.
        </p>
      ) : null}
    </div>
  );
};
