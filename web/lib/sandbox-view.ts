// What the shell sandbox panel shows. The console page owns it, so it survives the mobile drawer
// unmounting the panel and an open from outside the panel (a folder link) can drive it.
import type { WorkspacePath } from "./workspace-links";

export type PanelTab = "shell" | "agent" | "files";

export interface SandboxView {
  /** Undefined until the person or an open picks one; the panel then defaults by liveness. */
  readonly tab: PanelTab | undefined;
  /** A folder the Files tab should expand and scroll to, cleared once the tree applied it. */
  readonly reveal: WorkspacePath | undefined;
  /** Bumped on every reveal, so opening the same folder twice scrolls to it twice. */
  readonly revealSeq: number;
}

export type SandboxViewAction =
  | { readonly type: "tab"; readonly tab: PanelTab }
  /** Shows the Files tab at a folder. */
  | { readonly type: "reveal"; readonly path: WorkspacePath }
  /** The tree applied reveal `seq`; a newer reveal stays pending. */
  | { readonly type: "revealed"; readonly seq: number }
  | { readonly type: "reset" };

export const initialSandboxView: SandboxView = {
  tab: undefined,
  reveal: undefined,
  revealSeq: 0,
};

export const sandboxViewReducer = (
  view: SandboxView,
  action: SandboxViewAction
): SandboxView => {
  switch (action.type) {
    case "tab": {
      return { ...view, tab: action.tab };
    }
    case "reveal": {
      return {
        tab: "files",
        reveal: action.path,
        revealSeq: view.revealSeq + 1,
      };
    }
    case "revealed": {
      return action.seq === view.revealSeq
        ? { ...view, reveal: undefined }
        : view;
    }
    default: {
      return initialSandboxView;
    }
  }
};
