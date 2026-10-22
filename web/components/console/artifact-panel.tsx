"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, LayoutTemplate, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { runApi } from "@/lib/api";
import type { OpenArtifact } from "@/lib/artifacts";
import { artifactRenderUrl } from "@/lib/artifacts";

const Loading = () => (
  <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
    <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
    Loading…
  </p>
);

/**
 * The sandboxed page. It can't reach the network, and the console's `frame-src 'self'` CSP stops it from
 * navigating its frame elsewhere; a second load of the same frame still means it tried. The first time the frame
 * is reloaded; a page that keeps trying is replaced with a notice (local-harness's ArtifactFrame, ported).
 */
const ArtifactFrame = ({ src, title }: { src: string; title: string }) => {
  const loads = useRef({ frame: "", count: 0 });
  const [attempts, setAttempts] = useState(0);
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setAttempts(0);
  }
  if (attempts > 1) {
    return (
      <p role="alert" className="text-destructive p-4 text-sm">
        This page keeps trying to open another address, so it was stopped. Its
        source is under the Code tab.
      </p>
    );
  }
  const frame = `${src}#${attempts}`;
  return (
    <div className="relative h-full w-full">
      {attempts === 0 ? null : (
        <p
          role="alert"
          className="bg-warning/15 text-warning border-warning/30 absolute inset-x-0 top-0 z-10 border-b px-3 py-1.5 text-xs"
        >
          The page tried to open another address; it was blocked and reloaded.
        </p>
      )}
      <iframe
        key={frame}
        src={src}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => {
          if (loads.current.frame !== frame) {
            loads.current = { frame, count: 0 };
          }
          loads.current.count += 1;
          if (loads.current.count > 1) {
            setAttempts((n) => n + 1);
          }
        }}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
};

/** A version's page source under the Code tab, highlighted like the tool calls' output. */
const SourceCode = ({ html }: { html: string }) => {
  const lines = useHighlightedCode(html, "html");
  return (
    <CodeBlock size="sm" variant="flush" className="h-full">
      <CodeBlockActions>
        <CodeBlockCopyButton value={html} />
      </CodeBlockActions>
      <CodeBlockContent wrap lineNumbers className="min-h-0 flex-1">
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

const SourceView = ({
  conversation,
  id,
  version,
}: {
  conversation: number;
  id: string;
  version: number;
}) => {
  const { data, error } = useQuery({
    queryKey: ["artifact-source", conversation, id, version],
    queryFn: () =>
      runApi((c) =>
        c.artifacts.source({
          params: { id },
          query: { conversation, v: version },
        })
      ),
  });
  if (error === null) {
    return data === undefined ? <Loading /> : <SourceCode html={data.html} />;
  }
  return (
    <p role="alert" className="text-destructive p-4 text-sm">
      {error.message}
    </p>
  );
};

const TabSwitch = ({
  tab,
  onTab,
}: {
  tab: "page" | "code";
  onTab: (tab: "page" | "code") => void;
}) => (
  <div className="flex shrink-0 gap-1">
    {(
      [
        ["page", "Page"],
        ["code", "Code"],
      ] as const
    ).map(([value, label]) => (
      <button
        key={value}
        type="button"
        aria-pressed={tab === value}
        onClick={() => onTab(value)}
        className={buttonVariants({
          variant: tab === value ? "secondary" : "ghost",
          size: "sm",
        })}
      >
        {label}
      </button>
    ))}
  </div>
);

/**
 * An open artifact beside the chat: the rendered page in a sandboxed iframe, a version picker, the page's source,
 * and an open-in-new-tab link. The view is refetched while open so the agent's updates reach the picker; the
 * frame follows the newest version unless the person picked an older one.
 */
export const ArtifactPanel = ({
  artifact,
  conversation,
  onClose,
}: {
  artifact: OpenArtifact;
  conversation: number;
  onClose: () => void;
}) => {
  const { data, error } = useQuery({
    queryKey: ["artifact", conversation, artifact.id],
    queryFn: () =>
      runApi((c) =>
        c.artifacts.view({
          params: { id: artifact.id },
          query: { conversation },
        })
      ),
    refetchInterval: 2000,
  });
  const latest = data?.versions.at(-1)?.version;
  const [picked, setPicked] = useState<number | undefined>(artifact.version);
  const [seenLatest, setSeenLatest] = useState(latest);
  if (latest !== seenLatest) {
    setSeenLatest(latest);
    if (picked === undefined || picked === seenLatest) {
      setPicked(latest);
    }
  }
  const shown = picked ?? latest;
  const pageTitle = data?.title ?? "Page";
  const [tab, setTab] = useState<"page" | "code">("page");
  const versions = data?.versions ?? [];

  let body: ReactNode;
  if (error === null) {
    if (shown === undefined) {
      body = <Loading />;
    } else if (tab === "code") {
      body = (
        <SourceView
          conversation={conversation}
          id={artifact.id}
          version={shown}
        />
      );
    } else {
      body = (
        <ArtifactFrame
          src={artifactRenderUrl(conversation, artifact.id, shown)}
          title={pageTitle}
        />
      );
    }
  } else {
    body = (
      <p role="alert" className="text-destructive p-4 text-sm">
        {error.message}
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <LayoutTemplate className="text-muted-foreground size-4 shrink-0" />
        <span
          className="text-ui min-w-0 flex-1 truncate font-medium"
          title={pageTitle}
        >
          {pageTitle}
        </span>
        {versions.length === 0 || shown === undefined ? null : (
          <select
            aria-label="Version"
            value={shown}
            onChange={(event) => setPicked(Number(event.target.value))}
            className="text-muted-foreground bg-background h-7 shrink-0 rounded-md border px-1.5 text-base md:text-xs"
          >
            {versions.toReversed().map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version}
              </option>
            ))}
          </select>
        )}
        <TabSwitch tab={tab} onTab={setTab} />
        {shown === undefined ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  nativeButton={false}
                  render={
                    <a
                      href={artifactRenderUrl(conversation, artifact.id, shown)}
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
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the page"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
};

/** On desktop an artifact is a pane after the list or chat; dragging it shut closes it. */
export const ArtifactResizablePanel = ({
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

const SNAP_POINTS = [0.55, 0.95];

/**
 * Below the desktop breakpoint the same panel is a bottom drawer. Non-modal so it can stack over the sandbox
 * drawer and the transcript stays interactive; the content is data-vaul-no-drag so it scrolls instead of
 * dragging, and handleOnly restricts presses to the handle.
 */
export const ArtifactDrawer = ({
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
  <Drawer
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
    modal={false}
    snapPoints={SNAP_POINTS}
    handleOnly
  >
    <DrawerContent>
      <DrawerTitle className="sr-only">Artifact page</DrawerTitle>
      <div data-vaul-no-drag className="flex min-h-0 flex-1 flex-col">
        {artifact === undefined || conversation === undefined ? null : (
          <ArtifactPanel
            key={`${conversation}:${artifact.id}`}
            artifact={artifact}
            conversation={conversation}
            onClose={onClose}
          />
        )}
      </div>
    </DrawerContent>
  </Drawer>
);
