"use client";

import { ExternalLink, Monitor, MousePointer2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { vncViewUrl } from "@/lib/vnc";

export const DesktopPanel = ({
  vncUrl,
  ended,
}: {
  vncUrl: string | undefined;
  ended?: boolean;
}) => {
  const [control, setControl] = useState(false);

  if (vncUrl === undefined) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4">
        <Monitor className="size-5" />
        <p className="text-sm">
          {ended === true
            ? "The desktop was removed with its sandbox."
            : "No desktop view for this sandbox."}
        </p>
      </div>
    );
  }

  const src = vncViewUrl(vncUrl, control);
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
                nativeButton={false}
                render={
                  <a
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in new tab"
                  >
                    <ExternalLink />
                  </a>
                }
              />
            }
          />
          <TooltipContent>Open in new tab</TooltipContent>
        </Tooltip>
      </div>
      {/* noVNC needs scripts and its own origin (another port than this page, so it cannot reach this page). */}
      <iframe
        src={src}
        title="Sandbox desktop"
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin"
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
};
