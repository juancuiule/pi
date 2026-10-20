"use client";

import type { ArtifactInfo } from "effect-pi/api";
// Every conversation's artifacts, most recently updated first; a row opens the page in the same sandboxed
// panel the chat uses — the open pair lives in the URL (`?c&artifact[&v]`), so a refresh or a link shares it.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import {
  ArtifactResizablePanel,
  ArtifactSheet,
} from "@/components/console/artifact-panel";
import { PageHeader } from "@/components/console/page-header";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  artifactRenderUrl,
  artifactUrl,
  conversationTitleOf,
  openArtifactOf,
} from "@/lib/artifacts";
import { relativeTime } from "@/lib/format";
import { useArtifacts, useConversations } from "@/lib/queries";
import { DESKTOP_MEDIA, useMediaQuery } from "@/lib/use-media-query";
import { useNow } from "@/lib/use-now";

/**
 * The page's latest version, live but inert: the same sandboxed render the panel shows, scaled 4:1 into a
 * card. `pointer-events-none` lets the card's link take the click; keyed on the version so an `artifact_update`
 * reloads the thumbnail.
 */
const ArtifactThumb = ({ artifact }: { artifact: ArtifactInfo }) => (
  <div className="bg-background pointer-events-none aspect-video w-full overflow-hidden rounded-md border">
    <iframe
      key={artifact.versions.at(-1)?.version}
      src={artifactRenderUrl(artifact.conversation, artifact.id)}
      sandbox="allow-scripts"
      loading="lazy"
      tabIndex={-1}
      aria-hidden="true"
      title={`${artifact.title} preview`}
      className="h-[400%] w-[400%] origin-top-left scale-25 border-0"
    />
  </div>
);

const ArtifactsPage = () => {
  const router = useRouter();
  const open = openArtifactOf(useSearchParams());
  const close = () => router.push("/artifacts");
  const { data: artifacts } = useArtifacts();
  const { data: conversations } = useConversations();
  const isDesktop = useMediaQuery(DESKTOP_MEDIA);
  const now = useNow();

  const list = (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-6">
        {artifacts !== undefined && artifacts.length === 0 ? (
          <div>
            <p className="text-muted-foreground text-sm">No artifacts yet</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Pages the agent writes appear here.
            </p>
          </div>
        ) : null}
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {artifacts?.map((artifact) => (
            <li key={artifact.id} className="flex flex-col gap-1">
              <Link
                href={artifactUrl(artifact.conversation, artifact.id)}
                aria-current={
                  open?.artifact.id === artifact.id ? "page" : undefined
                }
                className="focus-visible:ring-ring group flex flex-col gap-1.5 rounded-md outline-none focus-visible:ring-2"
              >
                <ArtifactThumb artifact={artifact} />
                <span className="flex min-w-0 items-baseline gap-2 px-1">
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    title={artifact.title}
                  >
                    {artifact.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    v{artifact.versions.at(-1)?.version ?? "?"}
                    {" · "}
                    {relativeTime(artifact.updatedAt, now)}
                  </span>
                </span>
              </Link>
              <Link
                href={`/?c=${artifact.conversation}`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit max-w-full truncate rounded-md px-1 text-xs outline-none focus-visible:ring-2"
                title={conversationTitleOf(
                  conversations,
                  artifact.conversation
                )}
              >
                {conversationTitleOf(conversations, artifact.conversation)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </ScrollArea>
  );

  let body: ReactNode = null;
  if (isDesktop === true) {
    body = (
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel minSize="30%">{list}</ResizablePanel>
        <ArtifactResizablePanel
          artifact={open?.artifact}
          conversation={open?.conversation}
          onClose={close}
        />
      </ResizablePanelGroup>
    );
  } else if (isDesktop === false) {
    body = list;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>Artifacts · effect-pi</title>
      <PageHeader title="Artifacts" />
      {body}
      <ArtifactSheet
        artifact={open?.artifact}
        conversation={open?.conversation}
        isDesktop={isDesktop}
        onClose={close}
      />
    </div>
  );
};

export default ArtifactsPage;
