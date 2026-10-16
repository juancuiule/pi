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
  // Loads are counted per frame (per src and reload); each remount starts the count over by itself.
  const loads = useRef({ frame: "", count: 0 });
  const [attempts, setAttempts] = useState(0);
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    // A different page gets a fresh chance.
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
        // oxlint-disable-next-line react/iframe-missing-sandbox -- allow-scripts only, deliberately no allow-same-origin
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
    <CodeBlock size="sm" className="h-full">
      <CodeBlockActions>
        <CodeBlockCopyButton value={html} />
      </CodeBlockActions>
      <CodeBlockContent wrap lineNumbers className="min-h-0 flex-1">
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no id; the source only grows by version
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
  <div role="tablist" className="flex shrink-0 gap-1">
    {(
      [
        ["page", "Page"],
        ["code", "Code"],
      ] as const
    ).map(([value, label]) => (
      <button
        key={value}
        type="button"
        role="tab"
        aria-selected={tab === value}
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
    // The agent updates its own pages while the panel is open, like its own settings.
    refetchInterval: 2000,
  });
  const latest = data?.versions.at(-1)?.version;
  // Which version is on screen: the one opened or picked, following to the newest when it was the latest.
  const [picked, setPicked] = useState<number | undefined>(artifact.version);
  const [seenLatest, setSeenLatest] = useState(latest);
  if (latest !== seenLatest) {
    setSeenLatest(latest);
    if (picked === undefined || picked === seenLatest) {
      setPicked(latest);
    }
  }
  const shown = picked ?? latest;
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
          title={data?.title ?? "Page"}
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
        <span className="text-ui min-w-0 flex-1 truncate font-medium">
          {data?.title ?? "Page"}
        </span>
        {versions.length === 0 || shown === undefined ? null : (
          <select
            aria-label="Version"
            value={shown}
            onChange={(event) => setPicked(Number(event.target.value))}
            className="text-muted-foreground bg-background h-7 shrink-0 rounded-md border px-1.5 text-xs"
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
