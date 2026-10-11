"use client";

import { useState } from "react";

import { Toggle } from "@/components/ui/toggle";
import { vncViewUrl } from "@/lib/vnc";

export const DesktopPanel = ({ vncUrl }: { vncUrl: string | undefined }) => {
  const [control, setControl] = useState(false);

  if (vncUrl === undefined) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        No desktop view for this sandbox.
      </p>
    );
  }

  const src = vncViewUrl(vncUrl, control);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <Toggle
          size="sm"
          variant="outline"
          pressed={control}
          onPressedChange={setControl}
        >
          Take control
        </Toggle>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground text-sm underline"
        >
          Open in new tab
        </a>
      </div>
      {/* noVNC needs scripts and its own origin (another port than this page, so it cannot reach this page). */}
      <iframe
        src={src}
        title="Sandbox desktop"
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full border-0"
      />
    </div>
  );
};
