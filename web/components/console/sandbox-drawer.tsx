"use client";

import type { ConversationSummary } from "effect-pi/api";
import dynamic from "next/dynamic";
import { useState } from "react";

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import type { ConversationState } from "@/lib/conversation-state";
import { seatlessOf } from "@/lib/conversation-status";
import type { SandboxView, SandboxViewAction } from "@/lib/sandbox-view";

import { DesktopPanel } from "./desktop-panel";

// wterm loads its WASM at runtime, so the terminal never renders on the server.
const SandboxPanel = dynamic(
  async () => {
    const mod = await import("@/components/console/sandbox-panel");
    return mod.SandboxPanel;
  },
  { ssr: false }
);

const LOW_SNAP = 0.55;
const TOP_SNAP = 0.95;
const SNAP_POINTS = [LOW_SNAP, TOP_SNAP];

/** The sandbox's own panel — the desktop VNC view, or the shell/agent/files tabs. */
export const SandboxContent = ({
  conversation,
  state,
  resuming,
  view,
  onView,
}: {
  conversation: ConversationSummary;
  state: ConversationState;
  resuming: boolean;
  /** The shell panel's tab and pending folder reveal, owned by the console page. */
  view: SandboxView;
  onView: (action: SandboxViewAction) => void;
}) => (
  <div className="h-full min-h-0">
    {conversation.sandbox === "desktop" ? (
      <DesktopPanel
        conversation={conversation.id}
        desktop={conversation.desktop === true}
        paused={seatlessOf(conversation)}
        resuming={resuming}
      />
    ) : (
      <SandboxPanel
        id={conversation.id}
        live={!seatlessOf(conversation)}
        state={state}
        resuming={resuming}
        view={view}
        onView={onView}
      />
    )}
  </div>
);

/**
 * Below the desktop breakpoint the sandbox panel is a bottom drawer instead of a resizable pane. Non-modal so
 * the transcript stays interactive behind it and the artifact and file drawers can stack above. The content is
 * data-vaul-no-drag so its scrollable regions scroll instead of dragging; handleOnly restricts presses to the
 * handle so vaul's pointer capture can't swallow clicks aimed at the file tree's shadow-DOM rows. Closing
 * unmounts the panel; the shell's PTY lives on the server and replays on reconnect.
 */
export const SandboxDrawer = ({
  open,
  onOpenChange,
  conversation,
  state,
  resuming,
  view,
  onView,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: ConversationSummary | undefined;
  state: ConversationState;
  resuming: boolean;
  view: SandboxView;
  onView: (action: SandboxViewAction) => void;
}) => {
  const [snap, setSnap] = useState<number | string | null>(LOW_SNAP);
  // A folder link raises the drawer to its top snap: at the lower one the tree's lower rows sit
  // below the screen, where scrolling the tree cannot bring them.
  const [revealSeq, setRevealSeq] = useState(view.revealSeq);
  if (revealSeq !== view.revealSeq) {
    setRevealSeq(view.revealSeq);
    setSnap(TOP_SNAP);
  }
  if (conversation === undefined || conversation.sandbox === "none") {
    return null;
  }
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
      snapPoints={SNAP_POINTS}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
      handleOnly
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
            view={view}
            onView={onView}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
