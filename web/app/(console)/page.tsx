"use client";

import type { ConversationSummary } from "effect-pi/api";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";

import { ArtifactPanel } from "@/components/console/artifact-panel";
import { ConversationHeader } from "@/components/console/conversation-header";
import { DesktopPanel } from "@/components/console/desktop-panel";
import { FilePanel } from "@/components/console/file-panel";
import { MessageInput } from "@/components/console/message-input";
import { NewConversation } from "@/components/console/new-conversation";
import { Transcript } from "@/components/console/transcript";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AnswersContext, ApprovalContext } from "@/lib/approval-context";
import { OpenArtifactContext } from "@/lib/artifact-context";
import { latestArtifactCall } from "@/lib/artifacts";
import type { OpenArtifact } from "@/lib/artifacts";
import { parseConversationId } from "@/lib/conversation-id";
import type { ConversationState } from "@/lib/conversation-state";
import { OpenFileContext } from "@/lib/file-context";
import {
  useConversationAction,
  useConversations,
  useAnswerQuestions,
  useDecideApproval,
} from "@/lib/queries";
import { useConversationStore, useResuming } from "@/lib/store";
import { useConversationEvents } from "@/lib/use-conversation-events";
import { DESKTOP_MEDIA, useMediaQuery } from "@/lib/use-media-query";
import type { OpenFile } from "@/lib/workspace-files";

// wterm loads its WASM at runtime, so the terminal never renders on the server.
const SandboxPanel = dynamic(
  async () => {
    const mod = await import("@/components/console/sandbox-panel");
    return mod.SandboxPanel;
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

/**
 * The artifact open beside the chat, independent of the sandbox panel (a Level-none conversation has pages but
 * no machine). A just-committed `artifact_*` result opens it on its own; the calls already committed when the
 * first snapshot landed are the baseline, so a reload never pops the panel.
 */
const useArtifactPanel = (
  selectedId: number | undefined,
  state: ConversationState
): [OpenArtifact | undefined, (artifact: OpenArtifact | undefined) => void] => {
  const [artifact, setArtifact] = useState<OpenArtifact | undefined>();
  const [artifactConversation, setArtifactConversation] = useState(selectedId);
  if (artifactConversation !== selectedId) {
    setArtifactConversation(selectedId);
    setArtifact(undefined);
  }
  const seen = useRef<{ conversation?: number; callId?: string }>({});
  useEffect(() => {
    if (selectedId === undefined || !state.hydrated) {
      seen.current = {};
      return;
    }
    if (seen.current.conversation !== selectedId) {
      seen.current = {
        conversation: selectedId,
        callId: latestArtifactCall(state.entries)?.callId,
      };
      return;
    }
    const latest = latestArtifactCall(state.entries);
    if (latest !== undefined && latest.callId !== seen.current.callId) {
      seen.current.callId = latest.callId;
      setArtifact({ id: latest.id, version: latest.version });
    }
  }, [selectedId, state]);
  return [artifact, setArtifact];
};

/** The workspace file open beside the chat; tool calls and the Files tab open it, switching a conversation closes it. */
const useFilePanel = (
  selectedId: number | undefined
): [OpenFile | undefined, (file: OpenFile | undefined) => void] => {
  const [file, setFile] = useState<OpenFile | undefined>();
  const [fileConversation, setFileConversation] = useState(selectedId);
  if (fileConversation !== selectedId) {
    setFileConversation(selectedId);
    setFile(undefined);
  }
  return [file, setFile];
};

/** On desktop an artifact is a third pane after the main one; dragging it shut closes it. */
const ArtifactResizablePanel = ({
  artifact,
  conversation,
  onClose,
}: {
  artifact: OpenArtifact | undefined;
  conversation: number | undefined;
  onClose: () => void;
}) => {
  if (artifact === undefined || conversation === undefined) {
    return null;
  }
  return (
    <>
      <ResizableHandle />
      <ResizablePanel
        defaultSize="30%"
        minSize="15%"
        collapsible
        onResize={(size) => {
          if (size.asPercentage === 0) {
            onClose();
          }
        }}
      >
        <ArtifactPanel
          key={`${conversation}:${artifact.id}`}
          artifact={artifact}
          conversation={conversation}
          onClose={onClose}
        />
      </ResizablePanel>
    </>
  );
};

/** On desktop an open file is a pane between the main one and the sandbox's, like an artifact. */
const FileResizablePanel = ({
  file,
  conversation,
  onClose,
}: {
  file: OpenFile | undefined;
  conversation: number | undefined;
  onClose: () => void;
}) => {
  if (file === undefined || conversation === undefined) {
    return null;
  }
  return (
    <>
      <ResizableHandle />
      <ResizablePanel
        defaultSize="30%"
        minSize="15%"
        collapsible
        onResize={(size) => {
          if (size.asPercentage === 0) {
            onClose();
          }
        }}
      >
        <FilePanel
          key={`${conversation}:${file.path}`}
          file={file}
          conversation={conversation}
          onClose={onClose}
        />
      </ResizablePanel>
    </>
  );
};

/** Below the desktop breakpoint the same panel is a Sheet instead. */
const ArtifactSheet = ({
  artifact,
  conversation,
  isDesktop,
  onClose,
}: {
  artifact: OpenArtifact | undefined;
  conversation: number | undefined;
  isDesktop: boolean | null;
  onClose: () => void;
}) => (
  <Sheet
    open={
      isDesktop === false &&
      artifact !== undefined &&
      conversation !== undefined
    }
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
  >
    <SheetContent
      side="right"
      showCloseButton={false}
      className="w-full sm:max-w-2xl"
    >
      <SheetTitle className="sr-only">Artifact page</SheetTitle>
      {artifact === undefined || conversation === undefined ? null : (
        <ArtifactPanel
          key={`${conversation}:${artifact.id}`}
          artifact={artifact}
          conversation={conversation}
          onClose={onClose}
        />
      )}
    </SheetContent>
  </Sheet>
);

/** Below the desktop breakpoint an open file is a Sheet instead of a pane. */
const FileSheet = ({
  file,
  conversation,
  isDesktop,
  onClose,
}: {
  file: OpenFile | undefined;
  conversation: number | undefined;
  isDesktop: boolean | null;
  onClose: () => void;
}) => (
  <Sheet
    open={
      isDesktop === false && file !== undefined && conversation !== undefined
    }
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
  >
    <SheetContent
      side="right"
      showCloseButton={false}
      className="w-full sm:max-w-2xl"
    >
      <SheetTitle className="sr-only">Workspace file</SheetTitle>
      {file === undefined || conversation === undefined ? null : (
        <FilePanel
          key={`${conversation}:${file.path}`}
          file={file}
          conversation={conversation}
          onClose={onClose}
        />
      )}
    </SheetContent>
  </Sheet>
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

/** The approval and answer mutations bound to the open conversation, for its tool calls. */
const ConversationMutations = ({
  id,
  children,
}: {
  id: number;
  children: ReactNode;
}) => {
  const decideApproval = useDecideApproval(id);
  const answerQuestions = useAnswerQuestions(id);
  return (
    <ApprovalContext.Provider value={decideApproval}>
      <AnswersContext.Provider value={answerQuestions}>
        {children}
      </AnswersContext.Provider>
    </ApprovalContext.Provider>
  );
};

const Console = () => {
  const router = useRouter();
  const selectedId = parseConversationId(useSearchParams().get("c"));
  const select = (id: number) => router.push(`/?c=${id}`);
  const clear = () => router.push("/");

  const isDesktop = useMediaQuery(DESKTOP_MEDIA);
  const sidePanel = usePanelRef();
  const [sideCollapsed, setSideCollapsed] = useState(false);

  const state = useConversationEvents(selectedId);
  const thinkingHidden = useConversationStore(
    (store) =>
      selectedId !== undefined && store.hiddenThinking[selectedId] === true
  );
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

  const [artifact, setArtifact] = useArtifactPanel(selectedId, state);
  const [file, setFile] = useFilePanel(selectedId);

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
    main = <NewConversation onCreated={select} />;
  } else if (data !== undefined) {
    main = notFound ? (
      <NotFound onNew={clear} />
    ) : (
      // Keyed, so a draft or a take-control mode stays with its conversation.
      <ConversationMutations key={selectedId} id={selectedId}>
        <div className="flex h-full min-h-0 flex-col">
          {conversation === undefined ? null : (
            <ConversationHeader
              conversation={conversation}
              state={state}
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
            conversation={selectedId}
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
      </ConversationMutations>
    );
  }

  return (
    <OpenArtifactContext.Provider value={setArtifact}>
      <OpenFileContext.Provider value={setFile}>
        <title>{pageTitle(conversation)}</title>
        {isDesktop === true ? (
          // Nested inside the console shell's page panel: main, then open pages and files, then the sandbox.
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel minSize="30%">{main}</ResizablePanel>
            <ArtifactResizablePanel
              artifact={artifact}
              conversation={selectedId}
              onClose={() => setArtifact(undefined)}
            />
            <FileResizablePanel
              file={file}
              conversation={selectedId}
              onClose={() => setFile(undefined)}
            />
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
                      <SandboxPanel
                        id={conversation.id}
                        live={!seatlessOf(conversation)}
                        state={state}
                        resuming={resuming}
                      />
                    )}
                  </div>
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        ) : null}
        {isDesktop === false ? main : null}
        <ArtifactSheet
          artifact={artifact}
          conversation={selectedId}
          isDesktop={isDesktop}
          onClose={() => setArtifact(undefined)}
        />
        <FileSheet
          file={file}
          conversation={selectedId}
          isDesktop={isDesktop}
          onClose={() => setFile(undefined)}
        />
      </OpenFileContext.Provider>
    </OpenArtifactContext.Provider>
  );
};

export default Console;
