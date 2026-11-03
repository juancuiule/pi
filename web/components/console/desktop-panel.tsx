"use client";

import { cn } from "cn";
import { LoaderCircle, Monitor, MousePointer2, RotateCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SandboxView, SandboxViewAction } from "@/lib/sandbox-view";

import { FilesBrowser } from "./files-browser";
import { PanelTabs } from "./panel-tabs";

// noVNC reads `window` when imported, so the view loads only in the browser.
const DesktopView = dynamic(
  async () => {
    const mod = await import("@/components/console/desktop-view");
    return mod.DesktopView;
  },
  { ssr: false }
);

const DESKTOP_TABS = [
  ["desktop", "Live view"],
  ["files", "Files"],
] as const;

const placeholderText = (resuming: boolean, paused: boolean): string => {
  if (resuming) {
    return "Resuming — the desktop is starting over the saved workspace.";
  }
  if (paused) {
    return "Paused. The desktop comes back when the conversation resumes.";
  }
  return "No desktop view for this sandbox.";
};

const Placeholder = ({
  resuming,
  paused,
}: {
  resuming: boolean;
  paused: boolean;
}) => (
  <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4">
    {resuming ? (
      <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" />
    ) : (
      <Monitor className="size-5" />
    )}
    <p className="text-sm">{placeholderText(resuming, paused)}</p>
  </div>
);

/**
 * The desktop sandbox's side panel: the Live view of the desktop and the Files tab over its Workspace. The live
 * view stays mounted while Files is shown, so switching back does not reconnect; Files mounts on first visit.
 * The console page owns the view, so a folder link can switch to Files.
 */
export const DesktopPanel = ({
  conversation,
  desktop,
  paused = false,
  resuming = false,
  view,
  onView,
}: {
  conversation: number;
  /** The Sandbox has a desktop to watch. */
  desktop: boolean;
  /** Without a Seat, so without a desktop until it is resumed. */
  paused?: boolean;
  /** A resume is in flight: the new sandbox is still starting. */
  resuming?: boolean;
  view: SandboxView;
  onView: (action: SandboxViewAction) => void;
}) => {
  const [control, setControl] = useState(false);
  // Bumps to remount the view: the sandbox can be up while the connection dropped or stalled.
  const [reloadKey, setReloadKey] = useState(0);
  // The shell panel's other tabs, left over from before an Upgrade, show the live view.
  const tab = view.tab === "files" ? "files" : "desktop";
  const [filesSeen, setFilesSeen] = useState(tab === "files");
  if (tab === "files" && !filesSeen) {
    setFilesSeen(true);
  }
  const onRevealed = useCallback(
    (seq: number) => onView({ type: "revealed", seq }),
    [onView]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <Monitor className="text-muted-foreground size-4" />
        <span className="text-ui flex-1 font-medium">Desktop</span>
        {desktop && tab === "desktop" ? (
          <>
            <Toggle
              size="sm"
              variant="outline"
              pressed={control}
              onPressedChange={setControl}
            >
              <MousePointer2 />
              {control ? "In control" : "Take control"}
            </Toggle>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Reload desktop view"
                    onClick={() => setReloadKey((key) => key + 1)}
                  >
                    <RotateCw />
                  </Button>
                }
              />
              <TooltipContent>Reload the desktop view</TooltipContent>
            </Tooltip>
          </>
        ) : null}
        {resuming ? (
          <LoaderCircle
            aria-hidden
            className="text-muted-foreground size-3.5 motion-safe:animate-spin"
          />
        ) : null}
        <PanelTabs
          tabs={DESKTOP_TABS}
          tab={tab}
          onTab={(next) => onView({ type: "tab", tab: next })}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0 flex flex-col",
            tab !== "desktop" && "invisible"
          )}
        >
          {desktop ? (
            <DesktopView
              key={reloadKey}
              conversation={conversation}
              control={control}
            />
          ) : (
            <Placeholder resuming={resuming} paused={paused} />
          )}
        </div>
        {filesSeen ? (
          <div
            className={cn("absolute inset-0", tab !== "files" && "invisible")}
          >
            <FilesBrowser
              id={conversation}
              live={!paused}
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
