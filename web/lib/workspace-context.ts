"use client";

import { createContext, useContext } from "react";

import { EMPTY_INDEX } from "./workspace-links";
import type { WorkspaceIndex, WorkspaceTarget } from "./workspace-links";

/**
 * The open conversation's workspace, provided by the console page. Answers' path links, tool calls,
 * the Files tab, the shell's `open` (#101) and `@` mentions (#103) all go through it.
 */
export interface Workspace {
  /** What a mention may link to: empty without a live Sandbox, so every link goes quiet together. */
  readonly index: WorkspaceIndex;
  /** The one "open workspace path" action: a file opens the file pane, a folder the Files tab revealing it. */
  readonly open: (target: WorkspaceTarget) => void;
}

export const WorkspaceContext = createContext<Workspace>({
  index: EMPTY_INDEX,
  open: () => null,
});

export const useWorkspace = (): Workspace => useContext(WorkspaceContext);
