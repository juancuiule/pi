"use client";

import type { ArtifactInfo, ConversationSummary } from "effect-pi/api";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";

import {
  ArtifactDrawer,
  ArtifactList,
  ArtifactPanel,
  ArtifactResizablePanel,
} from "@/components/console/artifact-panel";
import { ConversationHeader } from "@/components/console/conversation-header";
import {
  FileDrawer,
  FileResizablePanel,
} from "@/components/console/file-panel";
import { MessageInput } from "@/components/console/message-input";
import { NewConversation } from "@/components/console/new-conversation";
import {
  SandboxContent,
  SandboxDrawer,
} from "@/components/console/sandbox-drawer";
import { Transcript } from "@/components/console/transcript";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { AnswersContext, ApprovalContext } from "@/lib/approval-context";
import { OpenArtifactContext } from "@/lib/artifact-context";
import {
  ARTIFACT_PANEL_CLOSED,
  latestArtifactCall,
  nextArtifactPanel,
} from "@/lib/artifacts";
import type {
  ArtifactPanelAction,
  ArtifactPanelState,
  OpenArtifact,
} from "@/lib/artifacts";
import { parseConversationId } from "@/lib/conversation-id";
import type { ConversationState } from "@/lib/conversation-state";
import {
  useConversationAction,
  useConversationArtifacts,
  useConversations,
  useAnswerQuestions,
  useDecideApproval,
  useWorkspaceIndex,
} from "@/lib/queries";
import { initialSandboxView, sandboxViewReducer } from "@/lib/sandbox-view";
import { useConversationStore, useResuming, useSimpleView } from "@/lib/store";
import { useConversationEvents } from "@/lib/use-conversation-events";
import { DESKTOP_MEDIA, useMediaQuery } from "@/lib/use-media-query";
import { WorkspaceContext } from "@/lib/workspace-context";
import type { OpenFile } from "@/lib/workspace-files";
import type { OpenTarget } from "@/lib/workspace-links";

const pageTitle = (conversation: ConversationSummary | undefined): string =>
  conversation === undefined
    ? "New conversation · effect-pi"
    : `${conversation.pendingApprovals > 0 ? "(Approval needed) " : ""}${conversation.title} · effect-pi`;

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
            {
              onError: (error) =>
                toast.error(error.message, { duration: Infinity }),
            }
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
 * The artifact panel beside the chat, independent of the sandbox panel (a Level-none conversation has pages but
 * no machine): closed, the conversation's list, or one artifact. A just-committed `artifact_*` result opens it
 * on its own; the calls already committed when the first snapshot landed are the baseline, so a reload never
 * pops the panel. Switching conversation closes it.
 */
const useArtifactPanel = (
  selectedId: number | undefined,
  state: ConversationState
): [ArtifactPanelState, (action: ArtifactPanelAction) => void] => {
  const [panel, dispatch] = useReducer(
    nextArtifactPanel,
    ARTIFACT_PANEL_CLOSED
  );
  const [artifactConversation, setArtifactConversation] = useState(selectedId);
  if (artifactConversation !== selectedId) {
    setArtifactConversation(selectedId);
    dispatch({ type: "close" });
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
      dispatch({
        type: "open",
        artifact: { id: latest.id, version: latest.version },
      });
    }
  }, [selectedId, state]);
  return [panel, dispatch];
};

/** What the artifact panel shows for the conversation, or null while it is closed. */
const artifactPanelContent = (
  panel: ArtifactPanelState,
  conversation: number | undefined,
  artifacts: readonly ArtifactInfo[] | undefined,
  dispatch: (action: ArtifactPanelAction) => void
): ReactNode => {
  if (conversation === undefined || panel.kind === "closed") {
    return null;
  }
  const close = () => dispatch({ type: "close" });
  return panel.kind === "list" ? (
    <ArtifactList
      artifacts={artifacts}
      onOpen={(artifact) => dispatch({ type: "open", artifact })}
      onClose={close}
    />
  ) : (
    <ArtifactPanel
      key={`${conversation}:${panel.artifact.id}`}
      artifact={panel.artifact}
      conversation={conversation}
      onBack={() => dispatch({ type: "back" })}
      onClose={close}
    />
  );
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

/** The sandbox panel's tab and pending folder reveal; switching a conversation starts over. */
const useSandboxView = (selectedId: number | undefined) => {
  const [view, dispatch] = useReducer(sandboxViewReducer, initialSandboxView);
  const [viewConversation, setViewConversation] = useState(selectedId);
  if (viewConversation !== selectedId) {
    setViewConversation(selectedId);
    dispatch({ type: "reset" });
  }
  return [view, dispatch] as const;
};

/** The header's panel button reads the same in both modes: it toggles the pane on desktop, the drawer below it. */
const sidePanelOf = (
  conversation: ConversationSummary,
  isDesktop: boolean | null,
  sideCollapsed: boolean,
  sandboxOpen: boolean,
  toggle: () => void
) => ({
  label: conversation.sandbox === "desktop" ? "desktop" : "terminal",
  collapsed: isDesktop === false ? !sandboxOpen : sideCollapsed,
  toggle,
});

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
  // The sandbox panel is a bottom drawer below the desktop breakpoint.
  const [sandboxOpen, setSandboxOpen] = useState(false);

  const state = useConversationEvents(selectedId);
  const thinkingHidden = useConversationStore(
    (store) =>
      selectedId !== undefined && store.hiddenThinking[selectedId] === true
  );
  const simple = useSimpleView(selectedId ?? -1);
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

  const [artifactPanel, dispatchArtifactPanel] = useArtifactPanel(
    selectedId,
    state
  );
  const { data: artifacts } = useConversationArtifacts(
    selectedId,
    state.running
  );
  const openArtifact = useCallback(
    (artifact: OpenArtifact) =>
      dispatchArtifactPanel({ type: "open", artifact }),
    [dispatchArtifactPanel]
  );
  const closeArtifactPanel = () => dispatchArtifactPanel({ type: "close" });
  const artifactContent = artifactPanelContent(
    artifactPanel,
    selectedId,
    artifacts,
    dispatchArtifactPanel
  );
  const [file, setFile] = useFilePanel(selectedId);
  const [view, dispatchView] = useSandboxView(selectedId);
  const index = useWorkspaceIndex(conversation, state.running);
  const openPath = useCallback(
    (target: OpenTarget) => {
      if (target.kind === "file") {
        setFile({ path: target.path });
        return;
      }
      if (isDesktop === true) {
        sidePanel.current?.expand();
      } else {
        setSandboxOpen(true);
      }
      dispatchView(
        target.kind === "root"
          ? { type: "tab", tab: "files" }
          : { type: "reveal", path: target.path }
      );
    },
    [dispatchView, isDesktop, setFile, sidePanel]
  );
  const workspace = useMemo(
    () => ({ index, open: openPath }),
    [index, openPath]
  );

  const toggleSidePanel = () => {
    if (isDesktop !== true) {
      setSandboxOpen((open) => !open);
      return;
    }
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
              artifacts={{
                available: artifacts !== undefined && artifacts.length > 0,
                open: artifactPanel.kind !== "closed",
                toggle: () => dispatchArtifactPanel({ type: "toggle" }),
              }}
              sidePanel={
                showSandbox
                  ? sidePanelOf(
                      conversation,
                      isDesktop,
                      sideCollapsed,
                      sandboxOpen,
                      toggleSidePanel
                    )
                  : undefined
              }
            />
          )}
          <Transcript
            state={state}
            conversation={selectedId}
            resuming={resuming}
            showThinking={!thinkingHidden}
            simple={simple}
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
    <OpenArtifactContext.Provider value={openArtifact}>
      <WorkspaceContext.Provider value={workspace}>
        <title>{pageTitle(conversation)}</title>
        {isDesktop === true ? (
          // Nested inside the console shell's page panel: main, then open pages and files, then the sandbox.
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel minSize="30%">{main}</ResizablePanel>
            <ArtifactResizablePanel
              open={artifactContent !== null}
              onClose={closeArtifactPanel}
            >
              {artifactContent}
            </ArtifactResizablePanel>
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
                  <SandboxContent
                    key={selectedId}
                    conversation={conversation}
                    state={state}
                    resuming={resuming}
                    view={view}
                    onView={dispatchView}
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        ) : null}
        {isDesktop === false ? (
          <>
            {main}
            <SandboxDrawer
              open={sandboxOpen}
              onOpenChange={setSandboxOpen}
              conversation={conversation}
              state={state}
              resuming={resuming}
              view={view}
              onView={dispatchView}
            />
          </>
        ) : null}
        <ArtifactDrawer
          open={artifactContent !== null}
          isDesktop={isDesktop}
          onClose={closeArtifactPanel}
        >
          {artifactContent}
        </ArtifactDrawer>
        <FileDrawer
          file={file}
          conversation={selectedId}
          isDesktop={isDesktop}
          onClose={() => setFile(undefined)}
        />
      </WorkspaceContext.Provider>
    </OpenArtifactContext.Provider>
  );
};

export default Console;
