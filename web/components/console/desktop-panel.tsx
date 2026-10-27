"use client";

import { LoaderCircle, Monitor, MousePointer2, RotateCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// noVNC reads `window` when imported, so the view loads only in the browser.
const DesktopView = dynamic(
  async () => {
    const mod = await import("@/components/console/desktop-view");
    return mod.DesktopView;
  },
  { ssr: false }
);

const placeholderText = (resuming: boolean, paused: boolean): string => {
  if (resuming) {
    return "Resuming — the desktop is starting over the saved workspace.";
  }
  if (paused) {
    return "Paused. The desktop comes back when the conversation resumes.";
  }
  return "No desktop view for this sandbox.";
};

export const DesktopPanel = ({
  conversation,
  desktop,
  paused,
  resuming = false,
}: {
  conversation: number;
  /** The Sandbox has a desktop to watch. */
  desktop: boolean;
  /** Without a Seat, so without a desktop until it is resumed. */
  paused?: boolean;
  /** A resume is in flight: the new sandbox is still starting. */
  resuming?: boolean;
}) => {
  const [control, setControl] = useState(false);
  // Bumps to remount the view: the sandbox can be up while the connection dropped or stalled.
  const [reloadKey, setReloadKey] = useState(0);

  if (!desktop) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4">
        {resuming ? (
          <LoaderCircle
            aria-hidden
            className="size-5 motion-safe:animate-spin"
          />
        ) : (
          <Monitor className="size-5" />
        )}
        <p className="text-sm">{placeholderText(resuming, paused ?? false)}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <Monitor className="text-muted-foreground size-4" />
        <span className="text-ui flex-1 font-medium">Desktop</span>
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
      </div>
      <DesktopView
        key={reloadKey}
        conversation={conversation}
        control={control}
      />
    </div>
  );
};
