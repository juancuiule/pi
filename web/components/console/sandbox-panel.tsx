"use client";

import { cn } from "cn";
import { LoaderCircle, SquareTerminal } from "lucide-react";
import { useCallback, useState } from "react";

import type { ConversationState } from "@/lib/conversation-state";
import type {
  PanelTab,
  SandboxView,
  SandboxViewAction,
} from "@/lib/sandbox-view";

import { FilesBrowser } from "./files-browser";
import { PanelTabs } from "./panel-tabs";
import { ShellTerminal } from "./shell-terminal";
import { TerminalPanel } from "./terminal-panel";

const SHELL_TABS = [
  ["shell", "Shell"],
  ["agent", "Agent"],
  ["files", "Files"],
] as const;

/**
 * The shell sandbox's side panel: an interactive Shell tab over the conversation's Sandbox, and the Agent tab
 * with the read-only view of the agent's commands. Both stay mounted once visited — the shell's socket and
 * scrollback would die with its terminal — so the inactive one is only hidden. The console page owns the
 * view, so a folder link can switch to Files.
 */
export const SandboxPanel = ({
  id,
  live,
  state,
  resuming = false,
  view,
  onView,
}: {
  id: number;
  /** The conversation has a Seat: `running` or `idle`. Without one the Shell tab shows why it is empty. */
  live: boolean;
  state: ConversationState;
  /** A resume is in flight: the seat's sandbox is still starting. */
  resuming?: boolean;
  view: SandboxView;
  onView: (action: SandboxViewAction) => void;
}) => {
  // "desktop" is the desktop panel's tab: an Upgrade never goes back, so only a stale view has it here.
  const fallback = live ? "shell" : "agent";
  const tab =
    view.tab === undefined || view.tab === "desktop" ? fallback : view.tab;
  const [seen, setSeen] = useState<ReadonlySet<PanelTab>>(() => new Set([tab]));
  if (!seen.has(tab)) {
    setSeen(new Set([...seen, tab]));
  }
  const onRevealed = useCallback(
    (seq: number) => onView({ type: "revealed", seq }),
    [onView]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <SquareTerminal className="text-muted-foreground size-4" />
        <span className="text-ui flex-1 font-medium">Terminal</span>
        {resuming ? (
          <LoaderCircle
            aria-hidden
            className="text-muted-foreground size-3.5 motion-safe:animate-spin"
          />
        ) : null}
        <PanelTabs
          tabs={SHELL_TABS}
          tab={tab}
          onTab={(next) => onView({ type: "tab", tab: next })}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {seen.has("shell") ? (
          <div
            className={cn("absolute inset-0", tab !== "shell" && "invisible")}
          >
            <ShellTerminal id={id} live={live} resuming={resuming} />
          </div>
        ) : null}
        <div className={cn("absolute inset-0", tab !== "agent" && "invisible")}>
          <TerminalPanel state={state} resuming={resuming} />
        </div>
        {seen.has("files") ? (
          <div
            className={cn("absolute inset-0", tab !== "files" && "invisible")}
          >
            <FilesBrowser
              id={id}
              live={live}
              reveal={view.reveal}
              revealSeq={view.revealSeq}
              onRevealed={onRevealed}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
