"use client";

import type { ConversationSummary } from "effect-pi/api";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import type { ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";

import { CapacityGuardProvider } from "@/components/console/capacity-dialog";
import { ConversationHeader } from "@/components/console/conversation-header";
import { DesktopPanel } from "@/components/console/desktop-panel";
import { MessageInput } from "@/components/console/message-input";
import { NewConversation } from "@/components/console/new-conversation";
import { Sidebar } from "@/components/console/sidebar";
import { Transcript } from "@/components/console/transcript";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ApprovalContext } from "@/lib/approval-context";
import {
  useConversationAction,
  useConversations,
  useDecideApproval,
} from "@/lib/queries";
import { useConversationStore, useResuming } from "@/lib/store";
import { useConversationEvents } from "@/lib/use-conversation-events";
import { useMediaQuery } from "@/lib/use-media-query";

// wterm loads its WASM at runtime, so the terminal never renders on the server.
const TerminalPanel = dynamic(
  async () => {
    const mod = await import("@/components/console/terminal-panel");
    return mod.TerminalPanel;
  },
  { ssr: false }
);

const pageTitle = (conversation: ConversationSummary | undefined): string =>
  conversation === undefined
    ? "New conversation · effect-pi"
    : `${conversation.pendingApprovals > 0 ? "(Approval needed) " : ""}${conversation.title} · effect-pi`;

/** Without a Seat, so without a Sandbox to show. */
const seatlessOf = (conversation: ConversationSummary) =>
  conversation.status === "paused" || conversation.status === "archived";

/** Read-only when the SSE 404'd (unknown id) or the conversation is archived. */
const readOnlyOf = (
  gone: boolean,
  conversation: ConversationSummary | undefined
) => gone || conversation?.status === "archived";

const parseId = (value: string | null): number | undefined => {
  const id = value === null ? Number.NaN : Number(value);
  return Number.isInteger(id) ? id : undefined;
};

const ArchivedNotice = ({ id, onNew }: { id: number; onNew: () => void }) => {
  const act = useConversationAction();
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-center gap-3 px-4 pb-6">
      <span className="text-muted-foreground text-sm">
        This conversation is archived.
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={act.isPending}
        onClick={() =>
          act.mutate(
            { id, action: "unarchive" },
            { onError: (error) => toast.error(error.message) }
          )
        }
      >
        Unarchive
      </Button>
      <Button variant="ghost" size="sm" onClick={onNew}>
        New conversation
      </Button>
    </div>
  );
};

const Composer = ({
  id,
  running,
  resuming,
  paused,
  readOnly,
  onNew,
}: {
  id: number;
  running: boolean;
  resuming: boolean;
  paused: boolean;
  readOnly: boolean;
  onNew: () => void;
}) =>
  readOnly ? (
    <ArchivedNotice id={id} onNew={onNew} />
  ) : (
    <MessageInput
      id={id}
      running={running}
      resuming={resuming}
      paused={paused}
    />
  );

const NotFound = ({ onNew }: { onNew: () => void }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
    <h1 className="text-base font-medium">Conversation not found</h1>
    <p className="text-muted-foreground text-sm">
      It may have ended, or the server restarted.
    </p>
    <Button variant="outline" size="sm" className="mt-2" onClick={onNew}>
      New conversation
    </Button>
  </div>
);

const Console = () => {
  const router = useRouter();
  const selectedId = parseId(useSearchParams().get("c"));
  const select = (id: number) => router.push(`/?c=${id}`);
  const clear = () => router.push("/");

  // Tailwind's md breakpoint: below it the sidebar is a Sheet and the side panel is hidden.
  const isDesktop = useMediaQuery("(min-width: 48rem)");
  const sidePanel = usePanelRef();
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const state = useConversationEvents(selectedId);
  const thinkingHidden = useConversationStore(
    (store) =>
      selectedId !== undefined && store.hiddenThinking[selectedId] === true
  );
  const decideApproval = useDecideApproval(selectedId ?? 0);
  const gone = useConversationStore(
    (store) => selectedId !== undefined && (store.ended[selectedId] ?? false)
  );
  const { data } = useConversations();
  const conversation = data?.find((c) => c.id === selectedId);
  const resuming = useResuming(conversation);
  const readOnly = readOnlyOf(gone, conversation);
  const showSandbox =
    conversation !== undefined && conversation.sandbox !== "none";
  // Not in the loaded list and either not yet marked ended or nothing arrived to show anyway.
  const notFound =
    selectedId !== undefined &&
    data !== undefined &&
    conversation === undefined &&
    !(readOnly && state.entries.length > 0);

  const toggleSidePanel = () => {
    const panel = sidePanel.current;
    if (panel === null) {
      return;
    }
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  };

  // While the list loads, show nothing: flashing a composer for a conversation that may not exist is worse.
  let main: ReactNode = null;
  if (selectedId === undefined) {
    main = (
      <NewConversation onCreated={select} onMenu={() => setMenuOpen(true)} />
    );
  } else if (data !== undefined) {
    main = notFound ? (
      <NotFound onNew={clear} />
    ) : (
      // Keyed, so a draft or a take-control mode stays with its conversation.
      <ApprovalContext.Provider key={selectedId} value={decideApproval}>
        <div className="flex h-full min-h-0 flex-col">
          {conversation === undefined ? null : (
            <ConversationHeader
              conversation={conversation}
              state={state}
              onMenu={() => setMenuOpen(true)}
              sidePanel={
                showSandbox && isDesktop
                  ? {
                      label:
                        conversation.sandbox === "desktop"
                          ? "desktop"
                          : "terminal",
                      collapsed: sideCollapsed,
                      toggle: toggleSidePanel,
                    }
                  : undefined
              }
            />
          )}
          <Transcript
            state={state}
            resuming={resuming}
            showThinking={!thinkingHidden}
          />
          <Composer
            id={selectedId}
            running={state.running}
            resuming={resuming}
            paused={conversation?.status === "paused"}
            readOnly={readOnly}
            onNew={clear}
          />
        </div>
      </ApprovalContext.Provider>
    );
  }

  return (
    <>
      <title>{pageTitle(conversation)}</title>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <Sidebar
            selectedId={selectedId}
            onSelect={(id) => {
              setMenuOpen(false);
              select(id);
            }}
            onNew={() => {
              setMenuOpen(false);
              clear();
            }}
          />
        </SheetContent>
      </Sheet>
      {isDesktop === true ? (
        <ResizablePanelGroup orientation="horizontal" className="h-dvh">
          <ResizablePanel defaultSize="260px" minSize="220px" maxSize="420px">
            <Sidebar selectedId={selectedId} onSelect={select} onNew={clear} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize="30%">{main}</ResizablePanel>
          {showSandbox ? (
            <>
              <ResizableHandle />
              <ResizablePanel
                panelRef={sidePanel}
                defaultSize="35%"
                minSize="15%"
                collapsible
                onResize={(size) => setSideCollapsed(size.asPercentage === 0)}
              >
                <div key={selectedId} className="h-full min-h-0">
                  {conversation.sandbox === "desktop" ? (
                    <DesktopPanel
                      vncUrl={conversation.vncUrl}
                      paused={seatlessOf(conversation)}
                      resuming={resuming}
                    />
                  ) : (
                    <TerminalPanel state={state} resuming={resuming} />
                  )}
                </div>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      ) : null}
      {isDesktop === false ? (
        <div className="flex h-dvh flex-col">{main}</div>
      ) : null}
    </>
  );
};

const Home = () => (
  <Suspense>
    <CapacityGuardProvider>
      <Console />
    </CapacityGuardProvider>
  </Suspense>
);

export default Home;
