"use client";

import { LoaderCircle } from "lucide-react";

import { useConversations } from "@/lib/queries";
import { vncViewUrl } from "@/lib/vnc";

/**
 * The document the Desktop panel frames: same-origin, so the console's `frame-src 'self'` lets it load, and
 * this page's own `frame-src http://127.0.0.1:*` then lets the sandbox's noVNC page load on its loopback port.
 */
export const DesktopFrame = ({
  conversation,
  control,
}: {
  conversation: number;
  control: boolean;
}) => {
  const { data, error } = useConversations();
  const vncUrl = data?.find((each) => each.id === conversation)?.vncUrl;

  if (data === undefined && error === null) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center p-4">
        <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" />
      </div>
    );
  }
  if (vncUrl === undefined) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center p-4">
        <p className="text-sm">
          {error === null ? "No desktop view for this sandbox." : error.message}
        </p>
      </div>
    );
  }
  return (
    <iframe
      src={vncViewUrl(vncUrl, control)}
      title="Sandbox desktop"
      // oxlint-disable-next-line react/iframe-missing-sandbox
      sandbox="allow-scripts allow-same-origin"
      className="block h-full w-full border-0"
    />
  );
};
