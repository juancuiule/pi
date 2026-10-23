import { describe, expect, it } from "vitest";

import { initialSandboxView, sandboxViewReducer } from "./sandbox-view";
import type { SandboxView, SandboxViewAction } from "./sandbox-view";
import type { WorkspacePath } from "./workspace-links";

const notes = "notes" as WorkspacePath;
const src = "src" as WorkspacePath;

const after = (...actions: SandboxViewAction[]): SandboxView => {
  let view = initialSandboxView;
  for (const action of actions) {
    view = sandboxViewReducer(view, action);
  }
  return view;
};

describe(sandboxViewReducer, () => {
  it("shows the Files tab at a revealed folder, once per reveal", () => {
    expect(after({ type: "reveal", path: notes })).toStrictEqual({
      tab: "files",
      reveal: notes,
      revealSeq: 1,
    });
    expect(
      after(
        { type: "reveal", path: notes },
        { type: "revealed", seq: 1 },
        { type: "reveal", path: notes }
      )
    ).toStrictEqual({ tab: "files", reveal: notes, revealSeq: 2 });
  });

  it("keeps a newer reveal pending when an older one is acknowledged", () => {
    expect(
      after(
        { type: "reveal", path: notes },
        { type: "reveal", path: src },
        { type: "revealed", seq: 1 }
      )
    ).toStrictEqual({ tab: "files", reveal: src, revealSeq: 2 });
  });

  it("switches tabs without dropping a pending reveal, and resets", () => {
    const shell = after(
      { type: "reveal", path: notes },
      { type: "tab", tab: "shell" }
    );
    expect(shell.tab).toBe("shell");
    expect(shell.reveal).toBe(notes);
    expect(sandboxViewReducer(shell, { type: "reset" })).toStrictEqual(
      initialSandboxView
    );
  });
});
