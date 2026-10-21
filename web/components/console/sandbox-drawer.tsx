"use client";

import type { ConversationSummary } from "effect-pi/api";
import dynamic from "next/dynamic";

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import type { ConversationState } from "@/lib/conversation-state";
import { seatlessOf } from "@/lib/conversation-status";

import { DesktopPanel } from "./desktop-panel";

// wterm loads its WASM at runtime, so the terminal never renders on the server.
const SandboxPanel = dynamic(
  async () => {
    const mod = await import("@/components/console/sandbox-panel");
    return mod.SandboxPanel;
  },
  { ssr: false }
);

const SNAP_POINTS = [0.55, 0.95];

/** The sandbox's own panel — the desktop VNC view, or the shell/agent/files tabs. */
export const SandboxContent = ({
  conversation,
  state,
  resuming,
}: {
  conversation: ConversationSummary;
  state: ConversationState;
  resuming: boolean;
}) => (
  <div className="h-full min-h-0">
    {conversation.sandbox === "desktop" ? (
      <DesktopPanel
        conversation={conversation.id}
        vncUrl={conversation.vncUrl}
        paused={seatlessOf(conversation)}
        resuming={resuming}
      />
    ) : (
      <SandboxPanel
        id={conversation.id}
        live={!seatlessOf(conversation)}
        state={state}
        resuming={resuming}
      />
    )}
  </div>
);

/**
 * Below the desktop breakpoint the sandbox panel is a bottom drawer instead of a resizable pane. Non-modal so
 * the transcript stays interactive behind it and the artifact and file sheets can stack above. The content is
 * data-vaul-no-drag so its scrollable regions scroll instead of dragging — the handle is the drag surface.
 * Closing unmounts the panel; the shell's PTY lives on the server and replays on reconnect.
 */
export const SandboxDrawer = ({
  open,
  onOpenChange,
  conversation,
  state,
  resuming,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: ConversationSummary | undefined;
  state: ConversationState;
  resuming: boolean;
}) => {
  if (conversation === undefined || conversation.sandbox === "none") {
    return null;
  }
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
      snapPoints={SNAP_POINTS}
    >
      <DrawerContent>
        <DrawerTitle className="sr-only">
          {conversation.sandbox === "desktop" ? "Desktop" : "Terminal"}
        </DrawerTitle>
        <div data-vaul-no-drag className="flex min-h-0 flex-1 flex-col">
          <SandboxContent
            key={conversation.id}
            conversation={conversation}
            state={state}
            resuming={resuming}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
