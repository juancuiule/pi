"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { ConversationHeader } from "@/components/console/conversation-header";
import { DesktopPanel } from "@/components/console/desktop-panel";
import { MessageInput } from "@/components/console/message-input";
import { NewConversation } from "@/components/console/new-conversation";
import { Sidebar } from "@/components/console/sidebar";
import { Transcript } from "@/components/console/transcript";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useConversations } from "@/lib/queries";
import { useConversationStore } from "@/lib/store";
import { useConversationEvents } from "@/lib/use-conversation-events";

// xterm touches `window`, so the terminal never renders on the server.
const TerminalPanel = dynamic(
  async () => {
    const mod = await import("@/components/console/terminal-panel");
    return mod.TerminalPanel;
  },
  { ssr: false }
);

const parseId = (value: string | null): number | undefined => {
  const id = value === null ? Number.NaN : Number(value);
  return Number.isInteger(id) ? id : undefined;
};

const Console = () => {
  const router = useRouter();
  const selectedId = parseId(useSearchParams().get("c"));
  const select = (id: number) => router.push(`/?c=${id}`);
  const clear = () => router.push("/");

  const state = useConversationEvents(selectedId);
  const ended = useConversationStore((store) =>
    selectedId === undefined ? false : store.ended[selectedId] === true
  );
  const { data } = useConversations();
  const conversation = data?.find((c) => c.id === selectedId);
  const showSandbox =
    conversation !== undefined && conversation.sandbox !== "none";

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-screen">
      <ResizablePanel defaultSize="20%" minSize="12%">
        <Sidebar selectedId={selectedId} onSelect={select} onNew={clear} />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize="30%">
        {selectedId === undefined ? (
          <NewConversation onCreated={select} />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {conversation === undefined ? null : (
              <ConversationHeader
                conversation={conversation}
                state={state}
                onEnded={clear}
              />
            )}
            <Transcript state={state} ended={ended} />
            <MessageInput
              id={selectedId}
              running={state.running}
              ended={ended}
            />
          </div>
        )}
      </ResizablePanel>
      {showSandbox ? (
        <>
          <ResizableHandle />
          <ResizablePanel defaultSize="35%" minSize="15%" collapsible>
            <div className="m-2 h-[calc(100%-1rem)] overflow-hidden rounded-lg border">
              {conversation.sandbox === "desktop" ? (
                <DesktopPanel vncUrl={conversation.vncUrl} />
              ) : (
                <TerminalPanel state={state} />
              )}
            </div>
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
};

const Home = () => (
  <Suspense>
    <Console />
  </Suspense>
);

export default Home;
