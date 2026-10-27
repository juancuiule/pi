"use client";

import RFB from "@novnc/novnc";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useInfo } from "@/lib/queries";
import { desktopUrl } from "@/lib/vnc";

type ViewState = "connecting" | "connected" | "disconnected";

/**
 * The Sandbox's desktop, drawn by noVNC's RFB client over the server's relay. Loaded only in the browser (noVNC
 * reads `window` when imported). View-only unless `control`; a dropped connection stays dropped until the panel
 * remounts it (its Reload button).
 */
export const DesktopView = ({
  conversation,
  control,
}: {
  conversation: number;
  control: boolean;
}) => {
  const screen = useRef<HTMLDivElement | null>(null);
  const client = useRef<RFB | null>(null);
  // Read when a connection starts, so taking control never reconnects.
  const controlling = useRef(control);
  const [state, setState] = useState<ViewState>("connecting");
  const { data: info } = useInfo();
  const apiUrl = info?.apiUrl;

  useEffect(() => {
    if (screen.current === null || apiUrl === undefined) {
      return;
    }
    const rfb = new RFB(
      screen.current,
      desktopUrl({
        apiUrl,
        pageOrigin: window.location.origin,
        conversation,
      })
    );
    rfb.viewOnly = !controlling.current;
    rfb.scaleViewport = true;
    rfb.background = "transparent";
    rfb.addEventListener("connect", () => setState("connected"));
    rfb.addEventListener("disconnect", () => setState("disconnected"));
    client.current = rfb;
    return () => {
      client.current = null;
      rfb.disconnect();
    };
  }, [apiUrl, conversation]);

  useEffect(() => {
    controlling.current = control;
    if (client.current !== null) {
      client.current.viewOnly = !control;
    }
  }, [control]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={screen} className="absolute inset-0" />
      {state === "connected" ? null : (
        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 p-4">
          {state === "connecting" ? (
            <LoaderCircle
              aria-hidden
              className="size-5 motion-safe:animate-spin"
            />
          ) : (
            <p className="text-sm">
              The desktop view disconnected. Reload it to connect again.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
